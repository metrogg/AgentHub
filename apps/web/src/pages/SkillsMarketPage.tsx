import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  Globe2,
  HardDrive,
  Link as LinkIcon,
  Loader2,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  TerminalSquare,
  Wand2,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import { api, type LoadedSkill, type SkillhubSearchItem, type SkillSummary } from '../lib/api'
import { cn } from '../lib/utils'

const defaultMarketUrl = 'https://www.skillhub.cn/skills'
const defaultQuery = 'skillhub'
const requiredSkillPacks = [
  {
    id: 'mattpocock-skills',
    name: 'Matt Pocock Skills',
    description: 'TypeScript、重构、测试与工程实践相关的高质量 Skills 包。',
    command: 'npx skills@latest add mattpocock/skills',
    packageRef: 'mattpocock/skills',
  },
]

type SelectedSkill =
  | { type: 'market'; item: SkillhubSearchItem }
  | { type: 'installed'; item: SkillSummary }

interface CustomSource {
  id: string
  name: string
  url: string
}

export default function SkillsMarketPage() {
  const navigate = useNavigate()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [query, setQuery] = useState(defaultQuery)
  const [results, setResults] = useState<SkillhubSearchItem[]>([])
  const [customSources, setCustomSources] = useState<CustomSource[]>([])
  const [selected, setSelected] = useState<SelectedSkill | null>(null)
  const [loadedSkill, setLoadedSkill] = useState<LoadedSkill | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')

  const installedIds = useMemo(() => new Set(skills.map((skill) => skill.id)), [skills])
  const hasRequiredSkills = useMemo(
    () =>
      requiredSkillPacks.some((pack) =>
        skills.some((skill) =>
          `${skill.id} ${skill.name} ${skill.description} ${skill.skillPath}`
            .toLowerCase()
            .includes(pack.packageRef.split('/').pop()?.toLowerCase() ?? pack.packageRef),
        ),
      ),
    [skills],
  )
  const marketSources = useMemo(
    () => [
      {
        id: 'skillhub',
        name: 'SkillHub 官方市场',
        description: '通过本机 skillhub CLI 搜索、安装和更新技能。',
        url: defaultMarketUrl,
        icon: <Globe2 className="h-4 w-4" />,
      },
      {
        id: 'local',
        name: '本机 Skills',
        description: '读取项目、storage、CODEX_HOME 中已经安装的技能。',
        url: 'local://skills',
        icon: <HardDrive className="h-4 w-4" />,
      },
      ...customSources.map((source) => ({
        id: source.id,
        name: source.name,
        description: '自定义 SKILL.md 或 GitHub 技能来源。',
        url: source.url,
        icon: <LinkIcon className="h-4 w-4" />,
      })),
    ],
    [customSources]
  )

  useEffect(() => {
    void refreshSkills()
    void searchSkillhub(defaultQuery)
  }, [])

  async function refreshSkills() {
    setLoading(true)
    try {
      const result = await api.listSkills()
      setSkills(result.items)
    } catch (error: any) {
      setMessage(error?.message || '读取 Skills 失败')
    } finally {
      setLoading(false)
    }
  }

  async function openInstalledDetail(skill: SkillSummary) {
    setSelected({ type: 'installed', item: skill })
    setLoadedSkill(null)
    setLoadingDetail(true)
    try {
      const detail = await api.getSkill(skill.id)
      setLoadedSkill(detail)
    } catch (error: any) {
      setMessage(error?.message || `读取 ${skill.name} 详情失败`)
    } finally {
      setLoadingDetail(false)
    }
  }

  async function installSkill(input = sourceUrl) {
    const trimmed = input.trim()
    if (!trimmed || installing) return
    setInstalling(true)
    setMessage('')
    try {
      const result = await api.installSkill({ sourceUrl: trimmed })
      setMessage(result.message)
      if (input === sourceUrl) setSourceUrl('')
      await refreshSkills()
      if (result.installed) await openInstalledDetail(result.installed)
    } catch (error: any) {
      setMessage(error?.message || '安装 Skill 失败')
    } finally {
      setInstalling(false)
    }
  }

  async function searchSkillhub(nextQuery = query) {
    const trimmed = nextQuery.trim()
    if (!trimmed || searching) return
    setSearching(true)
    setMessage('')
    try {
      const result = await api.searchSkillhub(trimmed)
      setResults(result.items)
      if (result.items[0]) setSelected({ type: 'market', item: result.items[0] })
      if (!result.items.length) setMessage('SkillHub 没有找到匹配的技能')
    } catch (error: any) {
      setResults([])
      setMessage(error?.message || 'SkillHub 搜索失败')
    } finally {
      setSearching(false)
    }
  }

  async function installFromSkillhub(slug: string) {
    if (!slug || installingSlug) return
    setInstallingSlug(slug)
    setMessage('')
    try {
      const result = await api.installSkillhub(slug)
      setMessage(result.message)
      await refreshSkills()
      if (result.installed) await openInstalledDetail(result.installed)
    } catch (error: any) {
      setMessage(error?.message || `安装 ${slug} 失败`)
    } finally {
      setInstallingSlug(null)
    }
  }

  function addCustomSource() {
    const url = sourceUrl.trim()
    if (!url) return
    const next: CustomSource = {
      id: `custom-${Date.now()}`,
      name: sourceName.trim() || '自定义来源',
      url,
    }
    setCustomSources((items) => [next, ...items])
    setSourceName('')
    setMessage(`已添加来源：${next.name}`)
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/coding-tools')}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
              aria-label="返回 Coding Tools"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <Wand2 className="h-4 w-4 text-emerald-700" />
            <span className="text-sm font-semibold">Skills 广场</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">发现、安装并嵌入 Agent</span>
          </div>
          <button
            type="button"
            onClick={refreshSkills}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新本机
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f5f1]">
          <div className="grid w-full items-start gap-4 p-5 xl:grid-cols-2">
            <section className="min-w-0 space-y-4">
              <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h1 className="text-xl font-semibold tracking-normal">SkillHub 市场</h1>
                    <p className="mt-1 text-sm text-neutral-500">支持市场搜索、SKILL.md 链接，以及受控的 npx skills 安装命令。</p>
                  </div>
                  <a
                    href={defaultMarketUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    <ExternalLink className="h-4 w-4" />
                    官网
                  </a>
                </div>

                <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50/60 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-950">
                        <Sparkles className="h-4 w-4 text-emerald-700" />
                        必装 Skills
                      </div>
                      <p className="mt-1 text-xs leading-5 text-emerald-800/75">
                        默认推荐安装 Matt Pocock 的 Skills 包，安装后会自动出现在本机 Skills 列表中。
                      </p>
                    </div>
                    <span className={cn(
                      'rounded-md px-2 py-1 text-xs font-medium',
                      hasRequiredSkills ? 'bg-white text-emerald-700' : 'bg-amber-50 text-amber-700',
                    )}>
                      {hasRequiredSkills ? '已检测到' : '待安装'}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {requiredSkillPacks.map((pack) => (
                      <div key={pack.id} className="flex flex-wrap items-center gap-2 rounded-md bg-white px-3 py-2">
                        <TerminalSquare className="h-4 w-4 shrink-0 text-emerald-700" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-neutral-950">{pack.name}</div>
                          <code className="mt-0.5 block truncate font-mono text-[11px] text-neutral-500">{pack.command}</code>
                        </div>
                        <button
                          type="button"
                          onClick={() => void installSkill(pack.command)}
                          disabled={installing}
                          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
                        >
                          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                          安装
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {marketSources.map((source) => (
                    <a
                      key={source.id}
                      href={source.url.startsWith('http') ? source.url : undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-[8rem] w-full items-start gap-3 rounded-lg border border-neutral-200 bg-[#fbfbf8] p-3 transition hover:border-neutral-300 hover:bg-white"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white text-neutral-600 shadow-sm">{source.icon}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{source.name}</span>
                        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-neutral-500">{source.description}</span>
                      </span>
                    </a>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <input
                    value={sourceName}
                    onChange={(event) => setSourceName(event.target.value)}
                    placeholder="来源名称"
                    className="h-10 w-40 rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-emerald-700"
                  />
                  <div className="flex h-10 min-w-[18rem] flex-1 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3">
                    <LinkIcon className="h-4 w-4 text-neutral-400" />
                    <input
                      value={sourceUrl}
                      onChange={(event) => setSourceUrl(event.target.value)}
                      placeholder="粘贴 SKILL.md / GitHub 链接 / npx skills@latest add owner/repo"
                      className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={addCustomSource}
                    disabled={!sourceUrl.trim() || sourceUrl.trim().startsWith('npx ')}
                    className="inline-flex h-10 min-w-[7.5rem] shrink-0 items-center justify-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:text-neutral-300"
                  >
                    <Plus className="h-4 w-4" />
                    添加来源
                  </button>
                  <button
                    type="button"
                    onClick={() => void installSkill()}
                    disabled={installing || !sourceUrl.trim()}
                    className="inline-flex h-10 min-w-[6.5rem] shrink-0 items-center justify-center gap-2 rounded-md bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
                  >
                    {installing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    安装技能
                  </button>
                </div>
                {message && <div className="mt-3 rounded-md bg-[#fbfbf8] px-3 py-2 text-xs leading-5 text-neutral-500">{message}</div>}
              </div>

              <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="flex min-w-0 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3">
                    <Search className="h-4 w-4 text-neutral-400" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void searchSkillhub()
                      }}
                      placeholder="搜索 SkillHub 技能，例如：代码审查、PPT、浏览器"
                      className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void searchSkillhub()}
                    disabled={searching || !query.trim()}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
                  >
                    {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    搜索市场
                  </button>
                </div>
              </div>

                <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-base font-semibold tracking-normal">SkillHub 市场</h2>
                      <p className="mt-1 text-sm text-neutral-500">卡片按来源、版本、安装状态整理，点击卡片查看详情。</p>
                    </div>
                    <span className="rounded-full bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600">{results.length} 个结果</span>
                  </div>

                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(17.5rem, 1fr))' }}>
                    {results.map((item) => (
                      <MarketSkillCard
                        key={item.slug}
                        item={item}
                        installed={installedIds.has(item.slug)}
                        active={selected?.type === 'market' && selected.item.slug === item.slug}
                        installing={installingSlug === item.slug}
                        disabled={Boolean(installingSlug)}
                        onSelect={() => setSelected({ type: 'market', item })}
                        onInstall={() => void installFromSkillhub(item.slug)}
                      />
                    ))}
                  </div>

                  {!searching && !results.length && (
                    <div className="rounded-lg border border-dashed border-neutral-200 bg-[#fbfbf8] px-4 py-12 text-center text-sm text-neutral-400">
                      输入关键词搜索 SkillHub 技能
                    </div>
                  )}

                  {searching && (
                    <div className="grid h-32 place-items-center rounded-lg border border-dashed border-neutral-200 bg-[#fbfbf8] text-sm text-neutral-400">
                      <span className="flex flex-col items-center gap-2">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        正在搜索 SkillHub
                      </span>
                    </div>
                  )}
                </div>
            </section>

            <aside className="sticky top-5 max-h-[calc(100vh-7.5rem)] min-h-0 space-y-4 overflow-y-auto">
                <SkillDetailPanel
                  selected={selected}
                  loadedSkill={loadedSkill}
                  loading={loadingDetail}
                  installed={selected?.type === 'market' ? installedIds.has(selected.item.slug) : false}
                  installing={selected?.type === 'market' ? installingSlug === selected.item.slug : false}
                  onInstall={selected?.type === 'market' ? () => void installFromSkillhub(selected.item.slug) : undefined}
                />
              <InstalledSkillsPanel
                skills={skills}
                selected={selected}
                onOpenSkill={(skill) => void openInstalledDetail(skill)}
              />
            </aside>
          </div>
        </div>
      </main>
    </div>
  )
}

function MarketSkillCard({
  active,
  disabled,
  installed,
  installing,
  item,
  onInstall,
  onSelect,
}: {
  active: boolean
  disabled: boolean
  installed: boolean
  installing: boolean
  item: SkillhubSearchItem
  onInstall: () => void
  onSelect: () => void
}) {
  return (
    <article
      className={cn(
        'flex min-h-52 flex-col rounded-lg border bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
        active ? 'border-neutral-950' : 'border-neutral-200'
      )}
    >
      <button type="button" onClick={onSelect} className="block min-h-0 flex-1 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="line-clamp-2 text-sm font-semibold leading-5 text-neutral-950">{cleanText(item.title, item.slug)}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">{item.slug}</div>
          </div>
          {item.version && <span className="shrink-0 rounded-md bg-neutral-50 px-2 py-1 text-xs text-neutral-500">v{item.version}</span>}
        </div>
        <p className="mt-3 line-clamp-4 text-xs leading-5 text-neutral-500">
          {cleanText(item.description, '暂无描述，点击查看来源与安装信息。')}
        </p>
      </button>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge icon={<Globe2 className="h-3.5 w-3.5" />}>{item.source || 'SkillHub'}</Badge>
          {installed && <Badge icon={<CheckCircle2 className="h-3.5 w-3.5" />}>已安装</Badge>}
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={installed || disabled}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
        >
          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : installed ? <PackageCheck className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          {installed ? '已装' : installing ? '安装中' : '安装'}
        </button>
      </div>
    </article>
  )
}

function InstalledSkillCard({
  active,
  onClick,
  skill,
}: {
  active: boolean
  onClick: () => void
  skill: SkillSummary
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border bg-white p-3 text-left transition hover:border-neutral-300',
        active ? 'border-neutral-950 shadow-sm' : 'border-neutral-200'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{cleanText(skill.name, skill.id)}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">skill:{skill.id}</div>
        </div>
        <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-700">{sourceLabel(skill.source)}</span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-neutral-500">{cleanText(skill.description, '暂无描述')}</p>
    </button>
  )
}

function InstalledSkillsPanel({
  onOpenSkill,
  selected,
  skills,
}: {
  onOpenSkill: (skill: SkillSummary) => void
  selected: SelectedSkill | null
  skills: SkillSummary[]
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">已安装 Skills</h2>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">{skills.length}</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))' }}>
        {skills.map((skill) => (
          <InstalledSkillCard
            key={`${skill.source}:${skill.id}`}
            skill={skill}
            active={selected?.type === 'installed' && selected.item.id === skill.id}
            onClick={() => onOpenSkill(skill)}
          />
        ))}
        {!skills.length && (
          <div className="rounded-lg border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
            暂无本机 Skills
          </div>
        )}
      </div>
    </section>
  )
}

function SkillDetailPanel({
  installed,
  installing,
  loadedSkill,
  loading,
  onInstall,
  selected,
}: {
  installed: boolean
  installing: boolean
  loadedSkill: LoadedSkill | null
  loading: boolean
  onInstall?: () => void
  selected: SelectedSkill | null
}) {
  if (!selected) {
    return (
      <aside className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <EmptyDetail />
      </aside>
    )
  }

  const isMarket = selected.type === 'market'
  const title = isMarket ? cleanText(selected.item.title, selected.item.slug) : cleanText(selected.item.name, selected.item.id)
  const id = isMarket ? selected.item.slug : selected.item.id
  const description = isMarket
    ? cleanText(selected.item.description, '暂无描述')
    : cleanText(loadedSkill?.description ?? selected.item.description, '暂无描述')
  const source = isMarket ? selected.item.source || 'SkillHub' : sourceLabel(selected.item.source)

  return (
    <aside className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="rounded-xl border border-neutral-200 bg-[#fbfbf8] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge icon={isMarket ? <Globe2 className="h-3.5 w-3.5" /> : <HardDrive className="h-3.5 w-3.5" />}>{source}</Badge>
              {isMarket && selected.item.version && <Badge>v{selected.item.version}</Badge>}
            </div>
            <h2 className="mt-3 break-words text-xl font-semibold tracking-normal">{title}</h2>
            <div className="mt-1 break-all font-mono text-xs text-neutral-400">skill:{id}</div>
          </div>
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-neutral-950 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
        </div>

        <div className="mt-5">
          <div className="text-xs font-medium text-neutral-400">简介</div>
          <p className="mt-2 text-sm leading-6 text-neutral-700">{description}</p>
        </div>

        <div className="mt-5 grid gap-2 text-sm">
          <InfoRow label="来源" value={source} />
          <InfoRow label="标识" value={id} />
          {!isMarket && <InfoRow label="路径" value={selected.item.skillPath} />}
        </div>

        {isMarket && (
          <>
            <div className="mt-5 rounded-lg border border-neutral-200 bg-white p-3">
              <div className="text-xs font-medium text-neutral-400">安装命令</div>
              <code className="mt-2 block break-all rounded-md bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700">
                skillhub install {id}
              </code>
            </div>
            <button
              type="button"
              onClick={onInstall}
              disabled={installed || installing}
              className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
            >
              {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : installed ? <PackageCheck className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {installed ? '已安装到本机' : installing ? '正在安装' : '安装到本机'}
            </button>
          </>
        )}
      </div>

      {!isMarket && (
        <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <BookOpen className="h-4 w-4" />
            Skill 详情
          </div>
          {loading && (
            <div className="grid h-32 place-items-center text-sm text-neutral-400">
              <span className="flex flex-col items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" />
                正在读取 SKILL.md
              </span>
            </div>
          )}
          {!loading && (
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-white p-0 text-xs leading-6 text-neutral-600">
              {cleanText(loadedSkill?.body ?? '', '暂无可预览内容')}
            </pre>
          )}
        </div>
      )}
    </aside>
  )
}

function EmptyDetail() {
  return (
    <div className="grid h-full min-h-[24rem] place-items-center rounded-xl border border-dashed border-neutral-200 bg-[#fbfbf8] p-6 text-center">
      <div>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm">
          <BookOpen className="h-5 w-5" />
        </div>
        <div className="mt-4 text-sm font-semibold">选择一个 Skill 查看详情</div>
        <p className="mt-2 text-xs leading-5 text-neutral-500">详情区会展示来源、版本、安装命令和本机 SKILL.md 内容。</p>
      </div>
    </div>
  )
}

function Badge({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600">
      {icon}
      {children}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2 rounded-md bg-white px-3 py-2">
      <span className="text-neutral-400">{label}</span>
      <span className="break-all text-neutral-700">{value}</span>
    </div>
  )
}

function sourceLabel(source: string) {
  if (source === 'skills') return '项目内置'
  if (source === 'storage' || source === 'skills-storage') return '本机安装'
  if (source.includes('.codex')) return 'Codex 本机'
  return source || '本机'
}

function cleanText(value: string | undefined | null, fallback: string) {
  const cleaned = (value ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[�]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}
