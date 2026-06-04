import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Download,
  HardDrive,
  Languages,
  Link as LinkIcon,
  Loader2,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  Store,
  X,
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import { api, type LoadedSkill, type SkillhubSearchItem, type SkillSummary } from '../lib/api'
import { cn } from '../lib/utils'

type ViewMode = 'market' | 'installed'
type SortMode = 'hot' | 'name' | 'installed'
type SourceBucket = 'all' | 'skillhub' | 'project' | 'local' | 'custom'

type SelectedSkill =
  | { type: 'market'; item: SkillhubSearchItem }
  | { type: 'installed'; item: SkillSummary }

interface CustomSource {
  id: string
  name: string
  url: string
}

const marketFilters: Array<{ value: SourceBucket; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'skillhub', label: 'SkillHub' },
  { value: 'local', label: '本机' },
  { value: 'custom', label: '外部来源' },
]

const installedFilters: Array<{ value: SourceBucket; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'project', label: '项目内置' },
  { value: 'local', label: '本机安装' },
  { value: 'custom', label: '外部来源' },
]

const sortOptions: Array<{ value: SortMode; label: string }> = [
  { value: 'hot', label: '热门' },
  { value: 'name', label: '名称' },
  { value: 'installed', label: '已安装优先' },
]

export default function SkillsMarketPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [marketQuery, setMarketQuery] = useState('')
  const [installedQuery, setInstalledQuery] = useState('')
  const [results, setResults] = useState<SkillhubSearchItem[]>([])
  const [customSources, setCustomSources] = useState<CustomSource[]>([])
  const [selected, setSelected] = useState<SelectedSkill | null>(null)
  const [loadedSkill, setLoadedSkill] = useState<LoadedSkill | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('market')
  const [sourceFilter, setSourceFilter] = useState<SourceBucket>('all')
  const [sortMode, setSortMode] = useState<SortMode>('hot')
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')

  const installedIds = useMemo(() => new Set(skills.map((skill) => skill.id)), [skills])
  const activeQuery = viewMode === 'market' ? marketQuery : installedQuery
  const activeFilters = viewMode === 'market' ? marketFilters : installedFilters
  const deepLinkedSkillId = useMemo(() => {
    return new URLSearchParams(location.search).get('skill')?.trim() ?? ''
  }, [location.search])

  const visibleMarketSkills = useMemo(() => {
    const query = normalizeSearch(marketQuery)
    const filtered = results.filter((item) => {
      const matchesQuery =
        !query ||
        normalizeSearch(`${item.title} ${item.slug} ${item.description} ${item.source}`).includes(
          query,
        )
      const matchesSource =
        sourceFilter === 'all' || classifySource(item.source || 'skillhub') === sourceFilter
      return matchesQuery && matchesSource
    })
    return sortMarketItems(filtered, sortMode, installedIds)
  }, [installedIds, marketQuery, results, sortMode, sourceFilter])

  const visibleInstalledSkills = useMemo(() => {
    const query = normalizeSearch(installedQuery)
    const filtered = skills.filter((skill) => {
      const matchesQuery =
        !query ||
        normalizeSearch(`${skill.name} ${skill.id} ${skill.description} ${skill.source}`).includes(
          query,
        )
      const matchesSource =
        sourceFilter === 'all' || classifySource(skill.source || 'local') === sourceFilter
      return matchesQuery && matchesSource
    })
    return sortInstalledSkills(filtered, sortMode)
  }, [installedQuery, skills, sortMode, sourceFilter])

  useEffect(() => {
    void refreshSkills()
    void loadMarketHome()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const nextView = params.get('view')
    if (nextView === 'installed' || params.has('skill')) {
      setViewMode('installed')
      return
    }
    if (nextView === 'market') setViewMode('market')
  }, [location.search])

  useEffect(() => {
    setSourceFilter('all')
  }, [viewMode])

  useEffect(() => {
    if (!deepLinkedSkillId || !skills.length) return
    const normalizedId = normalizeSearch(deepLinkedSkillId)
    const skill =
      skills.find((item) => normalizeSearch(item.id) === normalizedId) ??
      skills.find((item) => normalizeSearch(item.name) === normalizedId)
    if (!skill) {
      setViewMode('installed')
      setMessage(`未找到 Skill：${deepLinkedSkillId}`)
      return
    }
    setViewMode('installed')
    setInstalledQuery('')
    void openInstalledDetail(skill)
  }, [deepLinkedSkillId, skills])

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
      setSourceDialogOpen(false)
      await refreshSkills()
      if (result.installed) await openInstalledDetail(result.installed)
    } catch (error: any) {
      setMessage(error?.message || '安装 Skill 失败')
    } finally {
      setInstalling(false)
    }
  }

  async function loadMarketHome() {
    if (searching) return
    setSearching(true)
    setMessage('')
    try {
      const result = await api.searchSkillhub('*')
      setResults(result.items)
      if (!result.items.length) setMessage('SkillHub 暂时没有返回市场内容')
    } catch (error: any) {
      setResults([])
      setMessage(error?.message || '远程 Skills 加载失败')
    } finally {
      setSearching(false)
    }
  }

  async function searchSkillhub(nextQuery = marketQuery) {
    const trimmed = nextQuery.trim()
    if (searching) return
    if (!trimmed) {
      await loadMarketHome()
      return
    }
    setSearching(true)
    setMessage('')
    try {
      const result = await api.searchSkillhub(trimmed)
      setResults(result.items)
      if (!result.items.length) setMessage('远程 Skills 没有找到匹配项')
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
    if (!url || url.toLowerCase().startsWith('npx ')) return
    const next: CustomSource = {
      id: `custom-${Date.now()}`,
      name: sourceName.trim() || '自定义来源',
      url,
    }
    setCustomSources((items) => [next, ...items])
    setSourceName('')
    setMessage(`已添加来源：${next.name}`)
  }

  function updateSearchValue(value: string) {
    if (viewMode === 'market') {
      setMarketQuery(value)
    } else {
      setInstalledQuery(value)
    }
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && viewMode === 'market') void searchSkillhub()
  }

  function closeSelectedSkill() {
    setSelected(null)
    setLoadedSkill(null)
    const params = new URLSearchParams(location.search)
    if (!params.has('skill')) return
    params.delete('skill')
    const nextSearch = params.toString()
    navigate(nextSearch ? `/skills?${nextSearch}` : '/skills', { replace: true })
  }

  const totalCount = viewMode === 'market' ? visibleMarketSkills.length : visibleInstalledSkills.length

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f8f8f7] text-neutral-950">
      <div className="hidden shrink-0 lg:block">
        <SessionList />
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-[#f8f8f7]">
        <header className="shrink-0 border-b border-neutral-200 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => navigate('/coding-tools')}
                className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
                aria-label="返回 Coding Tools"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-normal">Skills 市场</h1>
                <p className="mt-0.5 truncate text-xs text-neutral-500">
                  远程发现和安装入口；已安装能力的审计请到能力商店。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={refreshSkills}
                className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 transition hover:bg-neutral-50"
                aria-label="刷新 Skills"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </button>
              <button
                type="button"
                onClick={() => setSourceDialogOpen(true)}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
              >
                <Plus className="h-4 w-4" />
                添加
              </button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[1580px] flex-col gap-4 px-5 py-5">
            <section className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-1">
                  <ViewModeButton
                    active={viewMode === 'market'}
                    icon={<Store className="h-4 w-4" />}
                    label="远程发现"
                    onClick={() => setViewMode('market')}
                  />
                  <ViewModeButton
                    active={viewMode === 'installed'}
                    icon={<HardDrive className="h-4 w-4" />}
                    label="已安装"
                    onClick={() => setViewMode('installed')}
                  />
                </div>
                <div className="hidden text-sm text-neutral-500 sm:block">
                  {viewMode === 'market' ? '远程 Skills 库' : '已安装 Skills'} · {totalCount}
                </div>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)_9rem]">
                <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
                  {activeFilters.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setSourceFilter(filter.value)}
                      className={cn(
                        'h-8 shrink-0 rounded-lg px-3 text-sm transition',
                        sourceFilter === filter.value
                          ? 'bg-neutral-950 text-white'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200',
                      )}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>

                <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3">
                  <Search className="h-4 w-4 shrink-0 text-neutral-400" />
                  <input
                    value={activeQuery}
                    onChange={(event) => updateSearchValue(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={viewMode === 'market' ? '搜索远程 Skills...' : '筛选已安装 Skills...'}
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                  />
                  {viewMode === 'market' && searching && (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />
                  )}
                </label>

                <label className="relative flex h-10 items-center rounded-lg border border-neutral-200 bg-white">
                  <select
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as SortMode)}
                    className="h-full w-full appearance-none bg-transparent pl-3 pr-9 text-sm text-neutral-700 outline-none"
                    aria-label="排序"
                  >
                    {sortOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-neutral-400" />
                </label>
              </div>
            </section>

            {message && (
              <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-600">
                {message}
              </div>
            )}

            {viewMode === 'market' ? (
              <MarketGrid
                installedIds={installedIds}
                installingSlug={installingSlug}
                items={visibleMarketSkills}
                searching={searching}
                selected={selected}
                onInstall={(slug) => void installFromSkillhub(slug)}
                onSelect={(item) => setSelected({ type: 'market', item })}
              />
            ) : (
              <InstalledGrid
                items={visibleInstalledSkills}
                loading={loading}
                selected={selected}
                onSelect={(skill) => void openInstalledDetail(skill)}
              />
            )}
          </div>
        </div>
      </main>

      {selected && (
        <SkillDrawer
          installed={selected.type === 'market' ? installedIds.has(selected.item.slug) : true}
          installing={selected.type === 'market' ? installingSlug === selected.item.slug : false}
          loadedSkill={loadedSkill}
          loading={loadingDetail}
          selected={selected}
          onClose={closeSelectedSkill}
          onInstall={selected.type === 'market' ? () => void installFromSkillhub(selected.item.slug) : undefined}
        />
      )}

      {sourceDialogOpen && (
        <SourceDialog
          customSources={customSources}
          installing={installing}
          sourceName={sourceName}
          sourceUrl={sourceUrl}
          onAddSource={addCustomSource}
          onClose={() => setSourceDialogOpen(false)}
          onInstall={() => void installSkill()}
          onRemoveSource={(id) => setCustomSources((items) => items.filter((item) => item.id !== id))}
          onSourceNameChange={setSourceName}
          onSourceUrlChange={setSourceUrl}
        />
      )}
    </div>
  )
}

function ViewModeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition',
        active ? 'bg-white text-neutral-950 shadow-sm' : 'text-neutral-500 hover:text-neutral-900',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function MarketGrid({
  installedIds,
  installingSlug,
  items,
  onInstall,
  onSelect,
  searching,
  selected,
}: {
  installedIds: Set<string>
  installingSlug: string | null
  items: SkillhubSearchItem[]
  onInstall: (slug: string) => void
  onSelect: (item: SkillhubSearchItem) => void
  searching: boolean
  selected: SelectedSkill | null
}) {
  if (searching && !items.length) {
    return <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />} text="正在搜索 SkillHub" />
  }

  if (!items.length) {
    return <EmptyState icon={<Search className="h-5 w-5" />} text="没有找到匹配的远程 Skills" />
  }

  return (
    <section className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(16rem, 1fr))' }}>
      {items.map((item) => (
        <MarketSkillCard
          key={item.slug}
          active={selected?.type === 'market' && selected.item.slug === item.slug}
          installed={installedIds.has(item.slug)}
          installing={installingSlug === item.slug}
          item={item}
          onInstall={() => onInstall(item.slug)}
          onSelect={() => onSelect(item)}
        />
      ))}
    </section>
  )
}

function InstalledGrid({
  items,
  loading,
  onSelect,
  selected,
}: {
  items: SkillSummary[]
  loading: boolean
  onSelect: (skill: SkillSummary) => void
  selected: SelectedSkill | null
}) {
  if (loading && !items.length) {
    return <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />} text="正在读取已安装 Skills" />
  }

  if (!items.length) {
    return <EmptyState icon={<BookOpen className="h-5 w-5" />} text="暂无匹配的已安装 Skills" />
  }

  return (
    <section className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(16rem, 1fr))' }}>
      {items.map((skill) => (
        <InstalledSkillCard
          key={`${skill.source}:${skill.id}`}
          active={selected?.type === 'installed' && selected.item.id === skill.id}
          skill={skill}
          onClick={() => onSelect(skill)}
        />
      ))}
    </section>
  )
}

function MarketSkillCard({
  active,
  installed,
  installing,
  item,
  onInstall,
  onSelect,
}: {
  active: boolean
  installed: boolean
  installing: boolean
  item: SkillhubSearchItem
  onInstall: () => void
  onSelect: () => void
}) {
  return (
    <article
      className={cn(
        'group flex min-h-[9.5rem] flex-col rounded-xl border bg-white p-4 transition hover:border-neutral-300 hover:shadow-sm',
        active ? 'border-neutral-950 ring-1 ring-neutral-950' : 'border-neutral-200',
      )}
    >
      <button type="button" onClick={onSelect} className="min-h-0 flex-1 text-left">
        <div className="line-clamp-2 text-sm font-semibold leading-5 text-neutral-950">
          {cleanText(item.title, item.slug)}
        </div>
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-neutral-600">
          {cleanText(item.description, '暂无描述')}
        </p>
      </button>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-neutral-400">@{cleanText(item.source, 'SkillHub')}</span>
          {item.version && <span className="text-xs text-neutral-300">v{item.version}</span>}
        </div>
        {installed ? (
          <Badge icon={<CheckCircle2 className="h-3.5 w-3.5" />}>已安装</Badge>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 text-xs font-medium text-neutral-600 opacity-0 transition hover:bg-neutral-50 group-hover:opacity-100 focus:opacity-100"
          >
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            安装
          </button>
        )}
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
        'flex min-h-[9.5rem] flex-col rounded-xl border bg-white p-4 text-left transition hover:border-neutral-300 hover:shadow-sm',
        active ? 'border-neutral-950 ring-1 ring-neutral-950' : 'border-neutral-200',
      )}
    >
      <div className="line-clamp-2 text-sm font-semibold leading-5 text-neutral-950">
        {cleanText(skill.name, skill.id)}
      </div>
      <p className="mt-3 line-clamp-3 flex-1 text-sm leading-6 text-neutral-600">
        {cleanText(skill.description, '暂无描述')}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="truncate text-xs text-neutral-400">@{sourceLabel(skill.source)}</span>
        <Badge>{classifySourceLabel(classifySource(skill.source))}</Badge>
      </div>
    </button>
  )
}

function SkillDrawer({
  installed,
  installing,
  loadedSkill,
  loading,
  onClose,
  onInstall,
  selected,
}: {
  installed: boolean
  installing: boolean
  loadedSkill: LoadedSkill | null
  loading: boolean
  onClose: () => void
  onInstall?: () => void
  selected: SelectedSkill
}) {
  const isMarket = selected.type === 'market'
  const title = isMarket
    ? cleanText(selected.item.title, selected.item.slug)
    : cleanText(selected.item.name, selected.item.id)
  const id = isMarket ? selected.item.slug : selected.item.id
  const description = isMarket
    ? cleanText(selected.item.description, '暂无描述')
    : cleanText(loadedSkill?.description ?? selected.item.description, '暂无描述')
  const source = isMarket ? cleanText(selected.item.source, 'SkillHub') : sourceLabel(selected.item.source)

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-label="关闭详情"
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[28rem] flex-col border-l border-neutral-200 bg-white shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge icon={isMarket ? <Store className="h-3.5 w-3.5" /> : <HardDrive className="h-3.5 w-3.5" />}>
                {source}
              </Badge>
              {isMarket && selected.item.version && <Badge>v{selected.item.version}</Badge>}
              {installed && <Badge icon={<PackageCheck className="h-3.5 w-3.5" />}>已安装</Badge>}
            </div>
            <h2 className="mt-3 break-words text-lg font-semibold tracking-normal">{title}</h2>
            <div className="mt-1 break-all font-mono text-xs text-neutral-400">skill:{id}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <div className="text-xs font-medium text-neutral-400">简介</div>
            <p className="mt-2 text-sm leading-6 text-neutral-700">{description}</p>

            <div className="mt-4 grid gap-2 text-sm">
              <InfoRow label="来源" value={source} />
              <InfoRow label="标识" value={id} />
              {!isMarket && <InfoRow label="路径" value={selected.item.skillPath} />}
            </div>

            {isMarket && (
              <>
                <div className="mt-4 rounded-lg border border-neutral-200 bg-white p-3">
                  <div className="text-xs font-medium text-neutral-400">安装命令</div>
                  <code className="mt-2 block break-all rounded-md bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700">
                    skillhub install {id}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={installed || installing}
                  className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-neutral-950 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
                >
                  {installing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : installed ? (
                    <PackageCheck className="h-4 w-4" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {installed ? '已安装到本机' : installing ? '正在安装' : '安装到本机'}
                </button>
              </>
            )}
          </section>

          {!isMarket && <SkillBodyWithTranslate body={loadedSkill?.body ?? ''} loading={loading} />}
        </div>
      </aside>
    </div>
  )
}

function SourceDialog({
  customSources,
  installing,
  onAddSource,
  onClose,
  onInstall,
  onRemoveSource,
  onSourceNameChange,
  onSourceUrlChange,
  sourceName,
  sourceUrl,
}: {
  customSources: CustomSource[]
  installing: boolean
  onAddSource: () => void
  onClose: () => void
  onInstall: () => void
  onRemoveSource: (id: string) => void
  onSourceNameChange: (value: string) => void
  onSourceUrlChange: (value: string) => void
  sourceName: string
  sourceUrl: string
}) {
  const canSaveSource = Boolean(sourceUrl.trim()) && !sourceUrl.trim().toLowerCase().startsWith('npx ')
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 px-4">
      <section className="w-full max-w-2xl rounded-2xl border border-neutral-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">添加 Skills 来源</h2>
            <p className="mt-1 text-sm text-neutral-500">粘贴 SKILL.md、GitHub 链接或 npx skills 命令。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
          <label className="md:col-span-2">
            <span className="text-sm font-medium text-neutral-700">来源地址</span>
            <div className="mt-2 flex h-10 items-center gap-2 rounded-lg border border-neutral-200 px-3">
              <LinkIcon className="h-4 w-4 shrink-0 text-neutral-400" />
              <input
                value={sourceUrl}
                onChange={(event) => onSourceUrlChange(event.target.value)}
                placeholder="https://.../SKILL.md 或 npx skills@latest add owner/repo"
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
              />
            </div>
          </label>

          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <div className="text-sm font-semibold">直接安装</div>
            <p className="mt-1 text-xs leading-5 text-neutral-500">
              会调用现有的 Skills 安装接口，成功后自动刷新已安装列表。
            </p>
            <button
              type="button"
              onClick={onInstall}
              disabled={!sourceUrl.trim() || installing}
              className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-neutral-950 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200"
            >
              {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              安装
            </button>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <label>
              <span className="text-sm font-semibold">保存为快捷来源</span>
              <input
                value={sourceName}
                onChange={(event) => onSourceNameChange(event.target.value)}
                placeholder="来源名称"
                className="mt-3 h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none placeholder:text-neutral-400"
              />
            </label>
            <button
              type="button"
              onClick={onAddSource}
              disabled={!canSaveSource}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:text-neutral-300"
            >
              <Plus className="h-4 w-4" />
              保存来源
            </button>
          </div>

          {customSources.length > 0 && (
            <div className="md:col-span-2 rounded-xl border border-neutral-200 p-3">
              <div className="mb-2 text-sm font-semibold">已保存来源</div>
              <div className="grid gap-2">
                {customSources.map((source) => (
                  <div
                    key={source.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-neutral-800">{source.name}</div>
                      <div className="truncate text-xs text-neutral-400">{source.url}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveSource(source.id)}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-white hover:text-neutral-900"
                      aria-label={`删除来源 ${source.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function SkillBodyWithTranslate({ body, loading }: { body: string; loading: boolean }) {
  const [translated, setTranslated] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [showTranslated, setShowTranslated] = useState(false)

  async function handleTranslate() {
    if (translated) {
      setShowTranslated((value) => !value)
      return
    }
    if (!body.trim() || translating) return
    setTranslating(true)
    setShowTranslated(true)
    setTranslated('')
    try {
      for await (const chunk of api.translate(body, 'zh')) {
        setTranslated((prev) => (prev ?? '') + chunk)
      }
    } catch {
      // Translation is helpful, but the original SKILL.md should remain usable if it fails.
    } finally {
      setTranslating(false)
    }
  }

  const displayText = showTranslated && translated != null ? translated : body

  return (
    <section className="mt-4 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <BookOpen className="h-4 w-4" />
          SKILL.md
        </div>
        {body.trim() && (
          <button
            type="button"
            onClick={handleTranslate}
            disabled={translating}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-50"
          >
            {translating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Languages className="h-3 w-3" />}
            {translating ? '翻译中...' : translated ? (showTranslated ? '查看原文' : '查看翻译') : 'AI 翻译'}
          </button>
        )}
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
        <pre className="max-h-[30rem] overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-xs leading-6 text-neutral-600">
          {cleanText(displayText, '暂无可预览内容')}
        </pre>
      )}
    </section>
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

function Badge({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600">
      {icon}
      {children}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2 rounded-lg bg-white px-3 py-2">
      <span className="text-neutral-400">{label}</span>
      <span className="break-all text-neutral-700">{value}</span>
    </div>
  )
}

function sortMarketItems(items: SkillhubSearchItem[], sortMode: SortMode, installedIds: Set<string>) {
  const next = items.slice()
  if (sortMode === 'name') {
    next.sort((a, b) => compareText(cleanText(a.title, a.slug), cleanText(b.title, b.slug)))
  }
  if (sortMode === 'installed') {
    next.sort((a, b) => Number(installedIds.has(b.slug)) - Number(installedIds.has(a.slug)))
  }
  return next
}

function sortInstalledSkills(items: SkillSummary[], sortMode: SortMode) {
  const next = items.slice()
  if (sortMode === 'name') {
    next.sort((a, b) => compareText(cleanText(a.name, a.id), cleanText(b.name, b.id)))
  }
  return next
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

function classifySource(source: string): SourceBucket {
  const value = source.trim().toLowerCase()
  if (!value) return 'custom'
  if (value.includes('skillhub')) return 'skillhub'
  if (value === 'skills' || value.includes('project')) return 'project'
  if (
    value.includes('storage') ||
    value.includes('local') ||
    value.includes('.codex') ||
    value.includes('codex')
  ) {
    return 'local'
  }
  return 'custom'
}

function classifySourceLabel(bucket: SourceBucket) {
  if (bucket === 'skillhub') return 'SkillHub'
  if (bucket === 'project') return '项目内置'
  if (bucket === 'local') return '本机'
  if (bucket === 'custom') return '外部'
  return '全部'
}

function sourceLabel(source: string) {
  if (source === 'skills') return '项目内置'
  if (source === 'storage' || source === 'skills-storage') return '本机安装'
  if (source.includes('.codex')) return 'Codex 本机'
  return source || '本机'
}

function normalizeSearch(value: string | undefined | null) {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function cleanText(value: string | undefined | null, fallback: string) {
  const cleaned = (value ?? '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[锟絔]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}
