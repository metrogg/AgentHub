import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Archive,
  ArrowDownToLine,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Database,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  Loader2,
  Monitor,
  PackageOpen,
  RefreshCw,
  Search,
  X,
  XCircle,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ArtifactPreviewSurface } from '../components/artifacts/ArtifactPreviewSurface'
import SessionList from '../components/chat/SessionList'
import {
  api,
  type OrchestratorRunListItem,
  type OrchestratorRunTaskSnapshot,
  type TypedBlackboardEntry,
} from '../lib/api'
import type { ArtifactPreviewItem } from '../lib/artifactPreview'
import { cn, relativeTime } from '../lib/utils'
import { useI18n } from '../lib/i18n'

type AssetKind = 'artifact' | 'handoff' | 'blackboard' | 'diff' | 'preview' | 'file' | 'deploy'
type AssetTypeFilter = AssetKind | 'all'

interface AssetItem {
  id: string
  kind: AssetKind
  title: string
  description: string
  runId: string
  runTitle: string
  workspaceId: string
  workspaceName: string
  taskId?: string | null
  taskTitle?: string
  agentId?: string | null
  status?: string
  path?: string
  url?: string
  source?: string
  updatedAt: string
  raw: unknown
}

const typeFilters: Array<{ value: AssetTypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'artifact', label: '产物' },
  { value: 'handoff', label: 'Handoff' },
  { value: 'blackboard', label: '黑板' },
  { value: 'preview', label: '预览' },
  { value: 'diff', label: 'Diff' },
  { value: 'file', label: '文件' },
  { value: 'deploy', label: '部署' },
]

export default function ArtifactsPage() {
  const navigate = useNavigate()
  const { language } = useI18n()
  const [runs, setRuns] = useState<OrchestratorRunListItem[]>([])
  const [blackboardByRun, setBlackboardByRun] = useState<Record<string, TypedBlackboardEntry[]>>({})
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [query, setQuery] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<AssetTypeFilter>('all')
  const [previewItem, setPreviewItem] = useState<ArtifactPreviewItem | null>(null)

  async function refresh() {
    setLoading(true)
    setMessage('')
    try {
      const result = await api.listOrchestratorRuns()
      setRuns(result.items)
      const firstRunId = result.items[0]?.id
      if (firstRunId && selectedRunId !== 'all' && !result.items.some((run) => run.id === selectedRunId)) {
        setSelectedRunId(firstRunId)
      }
      await loadBlackboardForRuns(result.items.slice(0, 12).map((run) => run.id))
    } catch (error: any) {
      setMessage(error?.message || '读取产物资产库失败')
    } finally {
      setLoading(false)
    }
  }

  async function loadBlackboardForRuns(runIds: string[]) {
    const missing = runIds.filter((runId) => !blackboardByRun[runId])
    if (!missing.length) return
    setDetailLoading(true)
    const results = await Promise.all(
      missing.map((runId) =>
        api
          .getOrchestratorRunBlackboard(runId)
          .then((result) => [runId, result.items] as const)
          .catch(() => [runId, [] as TypedBlackboardEntry[]] as const),
      ),
    )
    setBlackboardByRun((current) => {
      const next = { ...current }
      for (const [runId, entries] of results) next[runId] = entries
      return next
    })
    setDetailLoading(false)
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selectedRunId === 'all') return
    void loadBlackboardForRuns([selectedRunId])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId])

  const selectedRuns = useMemo(() => {
    if (selectedRunId === 'all') return runs
    return runs.filter((run) => run.id === selectedRunId)
  }, [runs, selectedRunId])

  const assets = useMemo(
    () => buildAssetItems(selectedRuns, blackboardByRun),
    [blackboardByRun, selectedRuns],
  )

  const filteredAssets = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return assets.filter((asset) => {
      const matchesType =
        typeFilter === 'all' ||
        asset.kind === typeFilter ||
        (typeFilter === 'artifact' && ['artifact', 'handoff', 'diff', 'preview', 'file', 'deploy'].includes(asset.kind))
      const matchesQuery =
        !keyword ||
        [
          asset.title,
          asset.description,
          asset.runTitle,
          asset.workspaceName,
          asset.taskTitle ?? '',
          asset.agentId ?? '',
          asset.path ?? '',
          asset.source ?? '',
          asset.status ?? '',
        ]
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      return matchesType && matchesQuery
    })
  }, [assets, query, typeFilter])

  const runOptions = useMemo(
    () =>
      runs.map((run) => ({
        id: run.id,
        label: `${run.workspaceName} / ${run.sessionTitle}`,
      })),
    [runs],
  )

  const partialCount = assets.filter((asset) => asset.status === 'failed' && asset.kind !== 'blackboard').length
  const handoffCount = assets.filter((asset) => asset.kind === 'handoff').length
  const blackboardCount = assets.filter((asset) => asset.kind === 'blackboard').length

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f8f6] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-neutral-200 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Archive className="h-4 w-4 text-emerald-700" />
                <h1 className="truncate text-lg font-semibold tracking-normal">产物</h1>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
                <span>{assets.length} 个资产</span>
                <span>{handoffCount} 个 handoff</span>
                <span>{blackboardCount} 条黑板摘要</span>
                {partialCount > 0 && <span>{partialCount} 个失败任务保留产物</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/orchestrator-runs')}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
              >
                <GitBranch className="h-4 w-4" />
                运行历史
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 transition hover:bg-neutral-50"
                aria-label="刷新产物"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 px-5 py-5">
            <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="grid gap-3 2xl:grid-cols-[18rem_minmax(0,1fr)_24rem]">
                <label className="relative flex h-10 items-center rounded-lg border border-neutral-200 bg-white">
                  <select
                    value={selectedRunId}
                    onChange={(event) => setSelectedRunId(event.target.value)}
                    className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-sm text-neutral-700 outline-none"
                    aria-label="选择运行"
                  >
                    <option value="all">全部运行</option>
                    {runOptions.map((run) => (
                      <option key={run.id} value={run.id}>
                        {run.label}
                      </option>
                    ))}
                  </select>
                  <ChevronRight className="pointer-events-none absolute right-3 h-4 w-4 rotate-90 text-neutral-400" />
                </label>

                <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
                  {typeFilters.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setTypeFilter(filter.value)}
                      className={cn(
                        'h-8 shrink-0 rounded-lg px-3 text-sm transition',
                        typeFilter === filter.value
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
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索文件、任务、Agent"
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

            {loading && assets.length === 0 ? (
              <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />} text="正在读取产物资产库" />
            ) : filteredAssets.length === 0 ? (
              <EmptyState icon={<PackageOpen className="h-5 w-5" />} text="还没有可展示的产物资产" />
            ) : (
              <section
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(23rem, 1fr))' }}
              >
                {filteredAssets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    language={language}
                    onPreview={() => setPreviewItem(assetToPreviewItem(asset))}
                  />
                ))}
              </section>
            )}

            {detailLoading && (
              <div className="flex items-center justify-center gap-2 pb-4 text-xs text-neutral-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在同步黑板摘要
              </div>
            )}
          </div>
        </div>
      </main>
      {previewItem && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-[min(58rem,calc(100vw-2rem))] flex-col border-l border-neutral-200 bg-white shadow-2xl">
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-950">{previewItem.title}</div>
              <div className="truncate text-xs text-neutral-500">{previewItem.subtitle ?? previewItem.path ?? previewItem.url ?? '产物预览'}</div>
            </div>
            <button
              type="button"
              onClick={() => setPreviewItem(null)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
              aria-label="关闭预览"
              title="关闭预览"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <ArtifactPreviewSurface
            className="min-h-0 flex-1"
            item={previewItem}
            workspaceId={previewItem.workspaceId}
          />
        </aside>
      )}
    </div>
  )
}

function AssetCard({
  asset,
  language,
  onPreview,
}: {
  asset: AssetItem
  language: 'zh' | 'en'
  onPreview: () => void
}) {
  const Icon = assetIcon(asset.kind)
  const openUrl = assetOpenUrl(asset)
  const downloadable = Boolean(asset.path && asset.workspaceId)
  const previewable = asset.kind !== 'blackboard' && (Boolean(openUrl) || Boolean(asset.path) || Boolean(asset.source))
  return (
    <article className="flex min-h-[18rem] flex-col rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-neutral-300">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', assetTone(asset.kind))}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="line-clamp-2 text-sm font-semibold leading-5 tracking-normal text-neutral-950">
                {asset.title}
              </h2>
              <KindBadge kind={asset.kind} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
              <span>{relativeTime(asset.updatedAt, language)}</span>
              {asset.status && <StatusBadge status={asset.status} />}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-4 line-clamp-3 text-sm leading-6 text-neutral-700">
        {asset.description || '该资产来自任务执行、handoff 或共享黑板。'}
      </p>

      <div className="mt-4 grid gap-2 text-xs">
        <InfoRow label="Run" value={`${asset.runTitle} · ${asset.runId.slice(0, 8)}`} />
        <InfoRow label="任务" value={asset.taskTitle || asset.taskId?.slice(0, 8) || '主群聊'} />
        <InfoRow label="Agent" value={asset.agentId || 'Orchestrator / 未绑定'} />
        {asset.path && <InfoRow label="路径" value={asset.path} />}
      </div>

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {previewable && (
          <button
            type="button"
            onClick={onPreview}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            {asset.kind === 'preview' || asset.kind === 'deploy' ? (
              <Monitor className="h-4 w-4" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            预览
          </button>
        )}
        {openUrl && (
          <button
            type="button"
            onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
          >
            <ExternalLink className="h-4 w-4" />
            新窗口
          </button>
        )}
        {downloadable && (
          <button
            type="button"
            onClick={() =>
              window.open(
                `/api/artifacts/file?workspaceId=${encodeURIComponent(asset.workspaceId)}&path=${encodeURIComponent(asset.path!)}`,
                '_blank',
                'noopener,noreferrer',
              )
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
          >
            <ArrowDownToLine className="h-4 w-4" />
            打开文件
          </button>
        )}
        <button
          type="button"
          onClick={() => window.open(`/orchestrator-runs?runId=${encodeURIComponent(asset.runId)}`, '_blank')}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
        >
          <GitBranch className="h-4 w-4" />
          查看运行
        </button>
      </div>
    </article>
  )
}

function buildAssetItems(
  runs: OrchestratorRunListItem[],
  blackboardByRun: Record<string, TypedBlackboardEntry[]>,
) {
  const items: AssetItem[] = []

  for (const run of runs) {
    for (const task of run.tasks ?? []) {
      const taskArtifacts = Array.isArray(task.artifacts) ? task.artifacts : []
      for (let index = 0; index < taskArtifacts.length; index += 1) {
        const artifact = taskArtifacts[index]
        const normalized = normalizeArtifact(artifact, task, run, index)
        if (normalized) items.push(normalized)
      }
    }

    for (const entry of blackboardByRun[run.id] ?? []) {
      items.push(normalizeBlackboardEntry(entry, run))
      const handoff = normalizeHandoffFromBlackboard(entry, run)
      if (handoff) items.push(handoff)
    }
  }

  const seen = new Set<string>()
  return items
    .filter((item) => {
      const key = [item.kind, item.runId, item.taskId ?? '', item.path ?? '', item.title].join('|')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function normalizeArtifact(
  value: unknown,
  task: OrchestratorRunTaskSnapshot,
  run: OrchestratorRunListItem,
  index: number,
): AssetItem | null {
  const record = asRecord(value)
  if (!record) return null
  const type = text(record.type)
  const path = text(record.path) || text(record.filePath)
  const url = text(record.url)
  const title = text(record.title) || path.split(/[\\/]/).pop() || `${task.title} 产物 ${index + 1}`
  const description = text(record.description) || artifactDescription(record)
  const createdAt = text(record.createdAt) || task.completedAt || task.startedAt || run.updatedAt
  const kind = artifactKind(record)
  return {
    id: `${run.id}:${task.id}:artifact:${text(record.id) || index}`,
    kind,
    title,
    description,
    runId: run.id,
    runTitle: run.sessionTitle,
    workspaceId: run.workspaceId,
    workspaceName: run.workspaceName,
    taskId: task.id,
    taskTitle: task.title,
    agentId: task.agentId,
    status: task.status,
    path,
    url,
    source: text(record.source) || type || 'task artifact',
    updatedAt: createdAt,
    raw: value,
  }
}

function normalizeBlackboardEntry(entry: TypedBlackboardEntry, run: OrchestratorRunListItem): AssetItem {
  const value = entry.value ?? { schemaType: 'fact', summary: '' }
  const summary = text(value.summary) || blackboardSummary(value)
  const title =
    text(value.title) ||
    text(value.taskTitle) ||
    text(value.filePath).split(/[\\/]/).pop() ||
    `${blackboardTypeLabel(value.schemaType)} / ${entry.key}`
  return {
    id: `${run.id}:blackboard:${entry.id}`,
    kind: 'blackboard',
    title,
    description: summary || entry.key,
    runId: run.id,
    runTitle: run.sessionTitle,
    workspaceId: run.workspaceId,
    workspaceName: run.workspaceName,
    taskId: entry.taskId ?? (text(value.taskId) || null),
    taskTitle: text(value.taskTitle),
    agentId: entry.agentId ?? (text(value.sourceAgentId) || null),
    path: text(value.filePath) || text(value.path),
    source: `${entry.namespace}/${entry.key}`,
    updatedAt: entry.createdAt,
    raw: entry,
  }
}

function normalizeHandoffFromBlackboard(entry: TypedBlackboardEntry, run: OrchestratorRunListItem): AssetItem | null {
  const value = entry.value ?? {}
  const handoffPath = text(value.handoffPath)
  if (!handoffPath) return null
  return {
    id: `${run.id}:handoff:${entry.id}`,
    kind: 'handoff',
    title: text(value.title) || text(value.taskTitle) || handoffPath.split(/[\\/]/).pop() || 'Handoff',
    description: text(value.summary) || '上游 Agent 已复制到 .agenthub/handoff 的交接资产。',
    runId: run.id,
    runTitle: run.sessionTitle,
    workspaceId: run.workspaceId,
    workspaceName: run.workspaceName,
    taskId: entry.taskId ?? (text(value.taskId) || null),
    taskTitle: text(value.taskTitle),
    agentId: entry.agentId ?? (text(value.sourceAgentId) || null),
    path: handoffPath,
    source: 'blackboard.handoffPath',
    updatedAt: entry.createdAt,
    raw: entry,
  }
}

function artifactKind(record: Record<string, unknown>): AssetKind {
  const type = text(record.type)
  const path = text(record.path) || text(record.filePath)
  if (type === 'diff') return 'diff'
  if (type === 'preview') return 'preview'
  if (type === 'deploy') return 'deploy'
  if (path.toLowerCase().includes('.agenthub/handoff')) return 'handoff'
  return 'file'
}

function artifactDescription(record: Record<string, unknown>) {
  const type = text(record.type)
  if (type === 'diff') return '代码变更 Diff，可用于审阅或应用。'
  if (type === 'preview') return '可打开的网页或静态站点预览。'
  if (type === 'deploy') return '部署或发布预览结果。'
  return text(record.mimeType) || text(record.status) || '任务执行生成的文件产物。'
}

function assetOpenUrl(asset: AssetItem) {
  if (asset.url) return asset.url
  if (!asset.path) return ''
  const lower = asset.path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return `/api/artifacts/preview-file?workspaceId=${encodeURIComponent(asset.workspaceId)}&path=${encodeURIComponent(asset.path)}`
  }
  if (/\.(png|jpe?g|webp|gif|svg|pdf|txt|md|json|csv)$/i.test(asset.path)) {
    return `/api/artifacts/file?workspaceId=${encodeURIComponent(asset.workspaceId)}&path=${encodeURIComponent(asset.path)}`
  }
  return ''
}

function assetToPreviewItem(asset: AssetItem): ArtifactPreviewItem {
  const openUrl = assetOpenUrl(asset)
  return {
    id: asset.id,
    title: asset.title,
    subtitle: asset.path ?? asset.source ?? assetKindLabel(asset.kind),
    description: asset.description,
    kind:
      asset.kind === 'preview'
        ? 'web'
        : asset.kind === 'deploy'
          ? 'deploy'
          : asset.kind === 'diff'
            ? 'diff'
            : inferPreviewKindFromAsset(asset),
    url: openUrl || asset.url || undefined,
    path: asset.path,
    source: asset.kind === 'diff' ? text(asRecord(asset.raw)?.diff) || asset.source : asset.source,
    workspaceId: asset.workspaceId,
  }
}

function inferPreviewKindFromAsset(asset: AssetItem): ArtifactPreviewItem['kind'] {
  const lower = `${asset.path ?? asset.url ?? asset.title}`.toLowerCase()
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(lower)) return 'image'
  if (/\.html?$/i.test(lower)) return 'web'
  return 'file'
}

function KindBadge({ kind }: { kind: AssetKind }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', assetTone(kind))}>
      {assetKindLabel(kind)}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const ok = status === 'done' || status === 'completed'
  const failed = status === 'failed'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        ok
          ? 'bg-emerald-50 text-emerald-700'
          : failed
            ? 'bg-red-50 text-red-700'
            : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : failed ? <XCircle className="h-3 w-3" /> : null}
      {taskStatusLabel(status)}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 rounded-lg bg-[#f8f8f5] px-3 py-2">
      <span className="text-neutral-400">{label}</span>
      <span className="truncate text-neutral-700" title={value}>
        {value}
      </span>
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

function assetIcon(kind: AssetKind) {
  const map = {
    artifact: Boxes,
    handoff: Archive,
    blackboard: Database,
    diff: FileDiff,
    preview: Monitor,
    file: FileText,
    deploy: Monitor,
  } satisfies Record<AssetKind, typeof Boxes>
  return map[kind]
}

function assetTone(kind: AssetKind) {
  const map: Record<AssetKind, string> = {
    artifact: 'bg-neutral-100 text-neutral-700',
    handoff: 'bg-emerald-50 text-emerald-700',
    blackboard: 'bg-cyan-50 text-cyan-700',
    diff: 'bg-indigo-50 text-indigo-700',
    preview: 'bg-blue-50 text-blue-700',
    file: 'bg-amber-50 text-amber-700',
    deploy: 'bg-violet-50 text-violet-700',
  }
  return map[kind]
}

function assetKindLabel(kind: AssetKind) {
  const map: Record<AssetKind, string> = {
    artifact: '产物',
    handoff: 'Handoff',
    blackboard: '黑板',
    diff: 'Diff',
    preview: '预览',
    file: '文件',
    deploy: '部署',
  }
  return map[kind]
}

function blackboardTypeLabel(type: TypedBlackboardEntry['value']['schemaType']) {
  const map: Record<TypedBlackboardEntry['value']['schemaType'], string> = {
    fact: '事实',
    decision: '决策',
    risk: '风险',
    artifact_ref: '产物',
    diff_summary: '变更',
    test_result: '测试',
    task_output: '任务产出',
  }
  return map[type] ?? type
}

function blackboardSummary(value: TypedBlackboardEntry['value']) {
  return (
    text(value.output) ||
    text(value.decision) ||
    text(value.risk) ||
    text(value.fact) ||
    text(value.command) ||
    text(value.filePath) ||
    text(value.path)
  )
}

function taskStatusLabel(status: string) {
  const map: Record<string, string> = {
    pending: '待执行',
    running: '执行中',
    done: '已完成',
    completed: '已完成',
    failed: '失败但可查看',
    cancelled: '已取消',
    blocked: '受阻',
  }
  return map[status] ?? status
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}
