import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileDiff,
  GitBranch,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import {
  api,
  type OrchestratorRunListItem,
  type ExecutionLog,
  type ConflictReportItem,
  type OrchestratorRunEvent,
  type OrchestratorProgressLedger,
  type OrchestratorTaskLedger,
  type TypedBlackboardEntry,
} from '../lib/api'
import { cn, relativeTime } from '../lib/utils'
import { useI18n } from '../lib/i18n'

export default function OrchestratorRunsPage() {
  const navigate = useNavigate()
  const { language } = useI18n()
  const [runs, setRuns] = useState<OrchestratorRunListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [query, setQuery] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<ExecutionLog[]>([])
  const [conflicts, setConflicts] = useState<ConflictReportItem[]>([])
  const [events, setEvents] = useState<OrchestratorRunEvent[]>([])
  const [blackboardEntries, setBlackboardEntries] = useState<TypedBlackboardEntry[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  )
  const selectedPlan = selectedRun?.plan && typeof selectedRun.plan === 'object'
    ? (selectedRun.plan as { taskLedger?: OrchestratorTaskLedger; progressLedger?: OrchestratorProgressLedger })
    : null
  const taskLedger = selectedPlan?.taskLedger ?? null
  const progressLedger = selectedPlan?.progressLedger ?? null

  async function refreshRuns() {
    setLoading(true)
    setMessage('')
    try {
      const result = await api.listOrchestratorRuns()
      setRuns(result.items)
      if (result.items.length && !selectedRunId) {
        setSelectedRunId(result.items[0].id)
      }
    } catch (error: any) {
      setMessage(error?.message || '读取运行历史失败')
    } finally {
      setLoading(false)
    }
  }

  async function loadRunDetail(runId: string) {
    setDetailLoading(true)
    try {
      const [logsResult, conflictsResult, eventsResult, blackboardResult] = await Promise.all([
        api.getOrchestratorRunLogs(runId),
        api.getOrchestratorRunConflicts(runId),
        api.getOrchestratorRunEvents(runId),
        api.getOrchestratorRunBlackboard(runId),
      ])
      setLogs(logsResult.items)
      setConflicts(conflictsResult.items)
      setEvents(eventsResult.items)
      setBlackboardEntries(blackboardResult.items)
    } catch (error: any) {
      setMessage(error?.message || '读取运行详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    void refreshRuns()
  }, [])

  useEffect(() => {
    if (selectedRunId) {
      void loadRunDetail(selectedRunId)
    }
  }, [selectedRunId])

  const filteredRuns = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return runs
    return runs.filter(
      (r) =>
        r.workspaceName.toLowerCase().includes(keyword) ||
        r.sessionTitle.toLowerCase().includes(keyword) ||
        r.status.includes(keyword)
    )
  }, [runs, query])

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/agent-world')}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
              aria-label="返回 Agent Group"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <GitBranch className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-semibold">编排运行历史</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">Orchestrator 多 Agent 协作执行记录</span>
          </div>
          <button
            type="button"
            onClick={refreshRuns}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f5f1]">
          <div className="grid h-full grid-cols-[22rem_minmax(0,1fr)] gap-4 p-5">
            {/* Left: Run list */}
            <section className="flex min-h-0 flex-col gap-4 overflow-hidden">
              <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3">
                  <Search className="h-4 w-4 text-neutral-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索 Workspace 或状态"
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                  />
                </div>
                {message && (
                  <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">{message}</div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
                {loading && runs.length === 0 && (
                  <div className="grid h-32 place-items-center text-sm text-neutral-400">
                    <span className="flex flex-col items-center gap-2">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      加载运行历史
                    </span>
                  </div>
                )}
                {!loading && filteredRuns.length === 0 && (
                  <div className="grid h-32 place-items-center text-sm text-neutral-400">
                    {query.trim() ? '没有匹配的运行记录' : '暂无运行记录'}
                  </div>
                )}
                <ul className="divide-y divide-neutral-100">
                  {filteredRuns.map((run) => (
                    <li key={run.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedRunId(run.id)}
                        className={cn(
                          'flex w-full items-start gap-3 px-4 py-3 text-left transition',
                          selectedRunId === run.id ? 'bg-indigo-50/60' : 'hover:bg-neutral-50'
                        )}
                      >
                        <StatusIcon status={run.status} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-neutral-900">
                              {run.workspaceName}
                            </span>
                            <span className="shrink-0 text-[11px] text-neutral-400">
                              {relativeTime(run.createdAt, language)}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-neutral-500">{run.sessionTitle}</div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <StatusBadge status={run.status} />
                            {Array.isArray(run.conflictReport) && run.conflictReport.length > 0 && (
                              <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                                <AlertTriangle className="h-3 w-3" />
                                {run.conflictReport.length} 冲突
                              </span>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* Right: Detail */}
            <section className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              {selectedRun ? (
                <>
                  <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold tracking-normal">{selectedRun.workspaceName}</h2>
                        <p className="mt-1 text-sm text-neutral-500">{selectedRun.sessionTitle}</p>
                      </div>
                      <StatusBadge status={selectedRun.status} large />
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-3 text-sm lg:grid-cols-3">
                      <InfoRow label="Run ID" value={selectedRun.id.slice(0, 8)} />
                      <InfoRow label="Workspace" value={selectedRun.workspaceName} />
                      <InfoRow label="会话" value={selectedRun.sessionTitle} />
                      <InfoRow
                        label="创建时间"
                        value={new Date(selectedRun.createdAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                      />
                      <InfoRow
                        label="更新时间"
                        value={new Date(selectedRun.updatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                      />
                      <InfoRow
                        label="任务数"
                        value={
                          typeof selectedRun.plan === 'object' && selectedRun.plan !== null
                            ? String((selectedRun.plan as any).tasks?.length ?? '-')
                            : '-'
                        }
                      />
                    </div>
                  </div>

                  {taskLedger && progressLedger && (
                    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                      <div className="mb-4 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-emerald-600" />
                          <h3 className="text-sm font-semibold">Progress Ledger</h3>
                        </div>
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          {progressLedger.completedTaskIds.length}/{taskLedger.tasks.length}
                        </span>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-3">
                        {taskLedger.phases.map((phase) => {
                          const phaseTasks = taskLedger.tasks.filter((task) => task.phaseId === phase.id)
                          const done = phaseTasks.filter((task) => progressLedger.completedTaskIds.includes(task.id)).length
                          const running = phaseTasks.some((task) => progressLedger.runningTaskIds.includes(task.id))
                          const failed = phaseTasks.some((task) => progressLedger.failedTaskIds.includes(task.id))
                          const contractCount = phaseTasks.filter((task) => task.outputContract).length
                          const validationCount = phaseTasks.filter((task) => task.validation?.commands?.length).length
                          return (
                            <div key={phase.id} className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-neutral-800">{phase.title}</span>
                                <span className={cn(
                                  'rounded px-1.5 py-0.5 text-[11px]',
                                  failed
                                    ? 'bg-red-50 text-red-700'
                                    : running
                                      ? 'bg-indigo-50 text-indigo-700'
                                      : done === phaseTasks.length && phaseTasks.length > 0
                                        ? 'bg-emerald-50 text-emerald-700'
                                        : 'bg-neutral-100 text-neutral-500',
                                )}>
                                  {failed ? 'failed' : running ? 'running' : `${done}/${phaseTasks.length}`}
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{phase.purpose}</p>
                              {(contractCount > 0 || validationCount > 0) && (
                                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                                  {contractCount > 0 && (
                                    <span className="rounded bg-white px-1.5 py-0.5 text-emerald-700">
                                      {contractCount} contracts
                                    </span>
                                  )}
                                  {validationCount > 0 && (
                                    <span className="rounded bg-white px-1.5 py-0.5 text-blue-700">
                                      {validationCount} validations
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-emerald-600" />
                        <h3 className="text-sm font-semibold">结构化黑板</h3>
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          {blackboardEntries.length} 条
                        </span>
                      </div>
                    </div>
                    {detailLoading && blackboardEntries.length === 0 ? (
                      <div className="grid h-24 place-items-center text-sm text-neutral-400">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    ) : blackboardEntries.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-neutral-200 bg-[#fbfbf8] px-4 py-8 text-center text-sm text-neutral-400">
                        暂无结构化证据
                      </div>
                    ) : (
                      <div className="grid gap-3 lg:grid-cols-2">
                        {blackboardEntries.slice(0, 10).map((entry) => (
                          <div key={`${entry.key}:${entry.version}`} className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', blackboardTone(entry).badgeClass)}>
                                    {blackboardTypeLabel(entry.value.schemaType)}
                                  </span>
                                  <span className="truncate font-mono text-[11px] text-neutral-400">{entry.key}</span>
                                </div>
                                <div className="mt-2 line-clamp-2 text-xs leading-5 text-neutral-700">
                                  {entry.value.summary || blackboardEntryDetail(entry)}
                                </div>
                                <div className="mt-1 text-[11px] leading-5 text-neutral-500">
                                  {blackboardEntryDetail(entry)}
                                </div>
                              </div>
                              <span className="shrink-0 text-[11px] text-neutral-400">
                                {relativeTime(entry.createdAt, language)}
                              </span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-neutral-500">
                              {entry.taskId && <span className="rounded bg-white px-1.5 py-0.5">task:{entry.taskId.slice(0, 8)}</span>}
                              {entry.agentId && <span className="rounded bg-white px-1.5 py-0.5">agent:{entry.agentId.slice(0, 8)}</span>}
                              <span className="rounded bg-white px-1.5 py-0.5">v{entry.version}</span>
                              {typeof entry.value.confidence === 'number' && (
                                <span className="rounded bg-white px-1.5 py-0.5">
                                  conf:{Math.round(entry.value.confidence * 100)}%
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                        {blackboardEntries.length > 10 && (
                          <div className="rounded-lg border border-dashed border-neutral-200 bg-[#fbfbf8] p-3 text-center text-xs text-neutral-400 lg:col-span-2">
                            还有 {blackboardEntries.length - 10} 条结构化条目
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-4 w-4 text-indigo-600" />
                        <h3 className="text-sm font-semibold">运行时间线</h3>
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                          {events.length} 条
                        </span>
                      </div>
                    </div>
                    {detailLoading && events.length === 0 ? (
                      <div className="grid h-24 place-items-center text-sm text-neutral-400">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    ) : events.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-neutral-200 bg-[#fbfbf8] px-4 py-8 text-center text-sm text-neutral-400">
                        暂无运行事件
                      </div>
                    ) : (
                      <ol className="relative space-y-3 before:absolute before:left-[0.8125rem] before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-neutral-200">
                        {events.map((event) => (
                          <li key={event.id} className="relative flex gap-3">
                            <div className={cn('z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border bg-white', eventTone(event).dotClass)}>
                              <TimelineIcon event={event} />
                            </div>
                            <div className="min-w-0 flex-1 rounded-lg border border-neutral-100 bg-[#fbfbf8] px-3 py-2">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-neutral-800">{eventTitle(event)}</div>
                                  <div className="mt-0.5 text-xs leading-5 text-neutral-500">{eventSummary(event)}</div>
                                </div>
                                <span className="shrink-0 text-[11px] text-neutral-400">
                                  {relativeTime(event.createdAt, language)}
                                </span>
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-neutral-500">
                                {event.taskId && <span className="rounded bg-white px-1.5 py-0.5">task:{event.taskId.slice(0, 8)}</span>}
                                {event.agentId && <span className="rounded bg-white px-1.5 py-0.5">agent:{event.agentId.slice(0, 8)}</span>}
                                <span className={cn('rounded px-1.5 py-0.5', eventTone(event).badgeClass)}>{event.severity}</span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {/* Conflicts */}
                  {conflicts.length > 0 && (
                    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                      <div className="mb-4 flex items-center gap-2">
                        <FileDiff className="h-4 w-4 text-amber-600" />
                        <h3 className="text-sm font-semibold">冲突报告</h3>
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          {conflicts.length} 个文件
                        </span>
                      </div>
                      <div className="space-y-4">
                        {conflicts.map((c, idx) => (
                          <div key={idx} className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-4">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-mono text-xs text-neutral-600">{c.filePath}</span>
                              <ConflictResolutionBadge resolution={c.resolution} />
                            </div>
                            {c.notes && (
                              <p className="mt-2 text-xs leading-5 text-neutral-500">{c.notes}</p>
                            )}
                            {c.variants.length > 0 && (
                              <div className="mt-3 space-y-2">
                                {c.variants.map((v, vidx) => (
                                  <div key={vidx} className="rounded border border-neutral-200 bg-white p-2">
                                    <div className="text-xs font-medium text-neutral-700">
                                      {v.agentName} ({v.agentId.slice(0, 8)})
                                    </div>
                                    {v.diff && (
                                      <pre className="mt-1 max-h-32 overflow-auto rounded bg-neutral-50 p-2 text-[11px] leading-4 text-neutral-600">
                                        {v.diff.slice(0, 800)}
                                        {v.diff.length > 800 && '...'}
                                      </pre>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {c.mergedContent && (
                              <div className="mt-3">
                                <div className="text-xs font-medium text-emerald-700">合并结果</div>
                                <pre className="mt-1 max-h-40 overflow-auto rounded border border-emerald-100 bg-emerald-50/40 p-2 text-[11px] leading-4 text-neutral-700">
                                  {c.mergedContent.slice(0, 1200)}
                                  {c.mergedContent.length > 1200 && '...'}
                                </pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Execution logs summary */}
                  <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-neutral-500" />
                        <h3 className="text-sm font-semibold">执行日志</h3>
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                          {logs.length} 条
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => navigate(`/execution-logs?runId=${selectedRun.id}`)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-500"
                      >
                        查看全部 <ChevronRight className="h-3 w-3" />
                      </button>
                    </div>
                    {detailLoading && logs.length === 0 ? (
                      <div className="grid h-24 place-items-center text-sm text-neutral-400">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    ) : logs.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-neutral-200 bg-[#fbfbf8] px-4 py-8 text-center text-sm text-neutral-400">
                        暂无执行日志
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {logs.slice(0, 6).map((log) => (
                          <div
                            key={log.id}
                            className="flex items-center gap-3 rounded-lg border border-neutral-100 bg-[#fbfbf8] px-3 py-2"
                          >
                            <LogTypeIcon type={log.type} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-neutral-700">{logTypeLabel(log.type)}</span>
                                <span className="shrink-0 text-[11px] text-neutral-400">
                                  {log.agentId.slice(0, 8)}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                                {log.taskId && <span>task:{log.taskId.slice(0, 8)}</span>}
                                {log.durationMs != null && <span>{log.durationMs}ms</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                        {logs.length > 6 && (
                          <div className="text-center text-xs text-neutral-400">
                            还有 {logs.length - 6} 条日志...
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <EmptyDetail />
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}

function StatusIcon({ status }: { status: OrchestratorRunListItem['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
    case 'failed':
      return <XCircle className="h-5 w-5 shrink-0 text-red-500" />
    case 'cancelled':
      return <ShieldAlert className="h-5 w-5 shrink-0 text-neutral-400" />
    case 'running':
    case 'synthesizing':
      return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-indigo-500" />
    default:
      return <Sparkles className="h-5 w-5 shrink-0 text-amber-500" />
  }
}

function TimelineIcon({ event }: { event: OrchestratorRunEvent }) {
  if (event.type.includes('failed')) return <XCircle className="h-3.5 w-3.5 text-red-500" />
  if (event.type.includes('completed')) return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
  if (event.type.includes('conflict')) return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
  if (event.type.includes('artifact')) return <FileDiff className="h-3.5 w-3.5 text-blue-500" />
  if (event.type.includes('blackboard')) return <GitBranch className="h-3.5 w-3.5 text-emerald-500" />
  if (event.type.includes('task')) return <PlayCircle className="h-3.5 w-3.5 text-indigo-500" />
  if (event.type.includes('synthesizing')) return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
  return <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
}

function eventTone(event: OrchestratorRunEvent) {
  if (event.severity === 'error') {
    return { dotClass: 'border-red-100 text-red-500', badgeClass: 'bg-red-50 text-red-700' }
  }
  if (event.severity === 'warning') {
    return { dotClass: 'border-amber-100 text-amber-500', badgeClass: 'bg-amber-50 text-amber-700' }
  }
  if (event.severity === 'debug') {
    return { dotClass: 'border-neutral-100 text-neutral-500', badgeClass: 'bg-neutral-100 text-neutral-600' }
  }
  return { dotClass: 'border-indigo-100 text-indigo-500', badgeClass: 'bg-indigo-50 text-indigo-700' }
}

function eventTitle(event: OrchestratorRunEvent) {
  const map: Record<OrchestratorRunEvent['type'], string> = {
    'run.started': '运行开始',
    'plan.created': '计划已创建',
    'plan.validated': '计划已校验',
    'approval.requested': '等待确认',
    'approval.granted': '确认通过',
    'phase.started': '阶段开始',
    'task.queued': '任务入队',
    'task.started': '任务开始',
    'task.stream': '任务输出',
    'blackboard.written': '黑板写入',
    'artifact.created': '产物生成',
    'task.completed': '任务完成',
    'task.failed': '任务失败',
    'task.cancelled': '任务取消',
    'task.retrying': '任务重试',
    'task.reassigned': '任务改派',
    'run.replanned': '运行重规划',
    'conflict.detected': '检测到冲突',
    'conflict.resolved': '冲突处理',
    'run.synthesizing': '正在汇总',
    'run.completed': '运行完成',
    'run.failed': '运行失败',
  }
  return map[event.type] ?? event.type
}

function eventSummary(event: OrchestratorRunEvent) {
  const payload = event.payload ?? {}
  const title = payloadText(payload.title)
  const taskTitle = payloadText(payload.taskTitle)
  const agentName = payloadText(payload.agentName)
  const filePath = payloadText(payload.filePath)
  const reason = payloadText(payload.reason)
  const error = payloadText(payload.error)
  const summary = payloadText(payload.summary)

  if (event.type === 'plan.created') {
    const taskCount = payloadText(payload.taskCount)
    const agentCount = payloadText(payload.agentCount)
    return `计划包含 ${taskCount || '-'} 个任务，${agentCount || '-'} 个 Agent。`
  }
  if (event.type === 'task.started') return `${agentName || 'Agent'} 开始处理${title ? `：${title}` : '任务'}。`
  if (event.type === 'task.completed') return `${agentName || 'Agent'} 完成${title ? `：${title}` : '任务'}。`
  if (event.type === 'task.failed') return error || `${agentName || 'Agent'} 执行失败。`
  if (event.type === 'task.retrying') return reason || '任务将按退避策略重试。'
  if (event.type === 'task.reassigned') return reason || '任务已改派给备用 Agent。'
  if (event.type === 'run.replanned') return reason || 'Orchestrator 已调整执行计划。'
  if (event.type === 'blackboard.written') return summary || `${taskTitle || '任务'} 写入了共享黑板。`
  if (event.type === 'artifact.created') return `${agentName || 'Agent'} 生成了${payloadText(payload.artifactKind) || '产物'}${filePath ? `：${filePath}` : ''}。`
  if (event.type === 'conflict.detected') return filePath ? `文件 ${filePath} 存在多 Agent 修改。` : '检测到多 Agent 变更冲突。'
  if (event.type === 'conflict.resolved') return filePath ? `文件 ${filePath} 的冲突处理结果：${payloadText(payload.resolution) || '-'}` : '冲突已处理。'
  if (event.type === 'run.synthesizing') return '所有可用任务结果已进入汇总阶段。'
  if (event.type === 'run.completed') return payloadText(payload.summaryMessageId) ? '最终汇总消息已写入群聊。' : '运行已结束。'
  if (event.type === 'run.failed') return error || '运行失败。'
  return title || reason || error || summary || event.type
}

function payloadText(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
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

function blackboardTone(entry: TypedBlackboardEntry) {
  if (entry.value.schemaType === 'risk') return { badgeClass: 'bg-amber-50 text-amber-700' }
  if (entry.value.schemaType === 'test_result' && entry.value.status === 'failed') {
    return { badgeClass: 'bg-red-50 text-red-700' }
  }
  if (entry.value.schemaType === 'decision') return { badgeClass: 'bg-blue-50 text-blue-700' }
  if (entry.value.schemaType === 'artifact_ref' || entry.value.schemaType === 'diff_summary') {
    return { badgeClass: 'bg-indigo-50 text-indigo-700' }
  }
  return { badgeClass: 'bg-emerald-50 text-emerald-700' }
}

function blackboardEntryDetail(entry: TypedBlackboardEntry) {
  const value = entry.value
  if (value.schemaType === 'task_output') {
    const agentName = payloadText(value.agentName)
    const taskTitle = payloadText(value.taskTitle)
    return [agentName, taskTitle].filter(Boolean).join(' / ')
  }
  if (value.schemaType === 'artifact_ref') {
    const title = payloadText(value.title)
    const filePath = payloadText(value.filePath)
    return filePath ? `${title || '产物'} · ${filePath}` : title
  }
  if (value.schemaType === 'diff_summary') {
    const changedFiles = Array.isArray(value.changedFiles) ? value.changedFiles.filter((item): item is string => typeof item === 'string') : []
    return changedFiles.length > 0 ? changedFiles.slice(0, 3).join(', ') : payloadText(value.branchName)
  }
  if (value.schemaType === 'decision') return payloadText(value.decision)
  if (value.schemaType === 'risk') return payloadText(value.risk)
  if (value.schemaType === 'fact') return payloadText(value.fact)
  if (value.schemaType === 'test_result') {
    return [payloadText(value.status), payloadText(value.command)].filter(Boolean).join(' · ')
  }
  return ''
}

function StatusBadge({ status, large = false }: { status: OrchestratorRunListItem['status']; large?: boolean }) {
  const map: Record<string, { text: string; className: string }> = {
    planning: { text: '规划中', className: 'bg-amber-50 text-amber-700' },
    running: { text: '运行中', className: 'bg-indigo-50 text-indigo-700' },
    synthesizing: { text: '汇总中', className: 'bg-blue-50 text-blue-700' },
    completed: { text: '已完成', className: 'bg-emerald-50 text-emerald-700' },
    failed: { text: '失败', className: 'bg-red-50 text-red-700' },
    cancelled: { text: '已取消', className: 'bg-neutral-100 text-neutral-600' },
  }
  const cfg = map[status] ?? { text: status, className: 'bg-neutral-100 text-neutral-600' }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        cfg.className,
        large && 'px-3 py-1 text-sm'
      )}
    >
      {cfg.text}
    </span>
  )
}

function ConflictResolutionBadge({ resolution }: { resolution: ConflictReportItem['resolution'] }) {
  const map: Record<string, { text: string; className: string }> = {
    'auto-merged': { text: '自动合并', className: 'bg-emerald-50 text-emerald-700' },
    'llm-resolved': { text: 'LLM 解决', className: 'bg-blue-50 text-blue-700' },
    'needs-human': { text: '需人工介入', className: 'bg-red-50 text-red-700' },
  }
  const cfg = map[resolution] ?? { text: resolution, className: 'bg-neutral-100 text-neutral-600' }
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', cfg.className)}>
      {cfg.text}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-100 bg-[#fbfbf8] px-3 py-2">
      <div className="text-[11px] text-neutral-400">{label}</div>
      <div className="mt-0.5 truncate text-xs text-neutral-700">{value}</div>
    </div>
  )
}

function LogTypeIcon({ type }: { type: ExecutionLog['type'] }) {
  switch (type) {
    case 'llm_call':
      return <Sparkles className="h-4 w-4 shrink-0 text-purple-500" />
    case 'tool_call':
      return <PlayCircle className="h-4 w-4 shrink-0 text-blue-500" />
    case 'blackboard_read':
    case 'blackboard_write':
      return <GitBranch className="h-4 w-4 shrink-0 text-emerald-500" />
    case 'error':
      return <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
    case 'task_start':
    case 'task_end':
      return <Clock className="h-4 w-4 shrink-0 text-neutral-500" />
    default:
      return <Clock className="h-4 w-4 shrink-0 text-neutral-400" />
  }
}

function logTypeLabel(type: ExecutionLog['type']) {
  const map: Record<string, string> = {
    llm_call: 'LLM 调用',
    tool_call: '工具调用',
    blackboard_read: '黑板读取',
    blackboard_write: '黑板写入',
    error: '错误',
    task_start: '任务开始',
    task_end: '任务结束',
  }
  return map[type] ?? type
}

function EmptyDetail() {
  return (
    <div className="grid h-full min-h-[24rem] place-items-center rounded-xl border border-dashed border-neutral-200 bg-[#fbfbf8] p-6 text-center">
      <div>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm">
          <GitBranch className="h-5 w-5" />
        </div>
        <div className="mt-4 text-sm font-semibold">选择一个运行记录</div>
        <p className="mt-2 text-xs leading-5 text-neutral-500">左侧列表展示所有 Orchestrator 运行历史，点击可查看详情、冲突报告和执行日志。</p>
      </div>
    </div>
  )
}
