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
  Pencil,
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
  type AgUiRunEvent,
  type OrchestratorRunListItem,
  type ExecutionLog,
  type ConflictReportItem,
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
  const [events, setEvents] = useState<AgUiRunEvent[]>([])
  const [blackboardEntries, setBlackboardEntries] = useState<TypedBlackboardEntry[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null)
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null)
  const [resolvingConflictFile, setResolvingConflictFile] = useState<string | null>(null)
  const [resolveNotes, setResolveNotes] = useState('')
  const [resolveMergedContent, setResolveMergedContent] = useState('')

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  )
  const selectedPlan =
    selectedRun?.plan && typeof selectedRun.plan === 'object'
      ? (selectedRun.plan as {
          taskLedger?: OrchestratorTaskLedger
          progressLedger?: OrchestratorProgressLedger
        })
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
        api.getAgUiRunEvents(runId),
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

  async function cancelRun(runId: string) {
    setCancellingRunId(runId)
    setMessage('')
    try {
      await api.cancelOrchestratorRun(runId)
      await refreshRuns()
      await loadRunDetail(runId)
    } catch (error: any) {
      setMessage(error?.message || '取消运行失败')
    } finally {
      setCancellingRunId(null)
    }
  }

  async function retryTask(runId: string, taskId: string) {
    setRetryingTaskId(taskId)
    setMessage('')
    try {
      await api.retryOrchestratorTask(runId, taskId)
      await refreshRuns()
      if (selectedRunId) await loadRunDetail(selectedRunId)
    } catch (error: any) {
      setMessage(error?.message || '重试任务失败')
    } finally {
      setRetryingTaskId(null)
    }
  }

  async function resolveConflict(
    runId: string,
    filePath: string,
    resolution: 'approved' | 'rejected' | 'overridden',
  ) {
    setMessage('')
    try {
      await api.resolveOrchestratorConflict(runId, {
        filePath,
        resolution,
        mergedContent: resolution === 'overridden' ? resolveMergedContent || undefined : undefined,
        notes: resolveNotes || undefined,
      })
      setResolvingConflictFile(null)
      setResolveNotes('')
      setResolveMergedContent('')
      if (selectedRunId) {
        const refreshed = await api.getOrchestratorRunConflicts(selectedRunId)
        setConflicts(refreshed.items)
      }
    } catch (error: any) {
      setMessage(error?.message || '处理冲突失败')
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
        r.status.includes(keyword),
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
              onClick={() => navigate('/agent-config')}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
              aria-label="返回 Agent Group"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <GitBranch className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-semibold">编排运行历史</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">
              Orchestrator 多 Agent 协作执行记录
            </span>
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
              <div className="bg-transparent">
                <div className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 shadow-sm">
                  <Search className="h-4 w-4 text-neutral-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索 Workspace 或状态"
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                  />
                </div>
                {message && (
                  <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">
                    {message}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto rounded-xl bg-transparent">
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
                <ul className="space-y-2">
                  {filteredRuns.map((run) => (
                    <li key={run.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedRunId(run.id)}
                        className={cn(
                          'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition',
                          selectedRunId === run.id
                            ? 'border-indigo-100 bg-indigo-50/70 shadow-sm'
                            : 'border-transparent hover:border-neutral-200 hover:bg-white/80',
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
                          <div className="mt-0.5 truncate text-xs text-neutral-500">
                            {run.sessionTitle}
                          </div>
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
            <section className="flex min-h-0 flex-col gap-4 overflow-y-auto bg-transparent">
              {selectedRun ? (
                <>
                  <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold tracking-normal">
                          {selectedRun.workspaceName}
                        </h2>
                        <p className="mt-1 text-sm text-neutral-500">{selectedRun.sessionTitle}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isCancellableRun(selectedRun.status) && (
                          <button
                            type="button"
                            onClick={() => void cancelRun(selectedRun.id)}
                            disabled={cancellingRunId === selectedRun.id}
                            className="inline-flex h-9 items-center gap-2 rounded-md border border-red-100 bg-red-50 px-3 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {cancellingRunId === selectedRun.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5" />
                            )}
                            取消运行
                          </button>
                        )}
                        <StatusBadge status={selectedRun.status} large />
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-3 text-sm lg:grid-cols-3">
                      <InfoRow label="Run ID" value={selectedRun.id.slice(0, 8)} />
                      <InfoRow label="Workspace" value={selectedRun.workspaceName} />
                      <InfoRow label="会话" value={selectedRun.sessionTitle} />
                      <InfoRow
                        label="创建时间"
                        value={new Date(selectedRun.createdAt).toLocaleString(
                          language === 'zh' ? 'zh-CN' : 'en-US',
                        )}
                      />
                      <InfoRow
                        label="更新时间"
                        value={new Date(selectedRun.updatedAt).toLocaleString(
                          language === 'zh' ? 'zh-CN' : 'en-US',
                        )}
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
                          const phaseTasks = taskLedger.tasks.filter(
                            (task) => task.phaseId === phase.id,
                          )
                          const done = phaseTasks.filter((task) =>
                            progressLedger.completedTaskIds.includes(task.id),
                          ).length
                          const running = phaseTasks.some((task) =>
                            progressLedger.runningTaskIds.includes(task.id),
                          )
                          const failed = phaseTasks.some((task) =>
                            progressLedger.failedTaskIds.includes(task.id),
                          )
                          const contractCount = phaseTasks.filter(
                            (task) => task.outputContract,
                          ).length
                          const validationCount = phaseTasks.filter(
                            (task) => task.validation?.commands?.length,
                          ).length
                          return (
                            <div
                              key={phase.id}
                              className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-neutral-800">
                                  {phase.title}
                                </span>
                                <span
                                  className={cn(
                                    'rounded px-1.5 py-0.5 text-[11px]',
                                    failed
                                      ? 'bg-red-50 text-red-700'
                                      : running
                                        ? 'bg-indigo-50 text-indigo-700'
                                        : done === phaseTasks.length && phaseTasks.length > 0
                                          ? 'bg-emerald-50 text-emerald-700'
                                          : 'bg-neutral-100 text-neutral-500',
                                  )}
                                >
                                  {failed
                                    ? 'failed'
                                    : running
                                      ? 'running'
                                      : `${done}/${phaseTasks.length}`}
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">
                                {phase.purpose}
                              </p>
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
                              {phaseTasks.length > 0 && (
                                <div className="mt-2 space-y-1.5">
                                  {phaseTasks.map((task) => {
                                    const taskStatus = progressLedger.completedTaskIds.includes(
                                      task.id,
                                    )
                                      ? 'completed'
                                      : progressLedger.runningTaskIds.includes(task.id)
                                        ? 'running'
                                        : progressLedger.failedTaskIds.includes(task.id)
                                          ? 'failed'
                                          : progressLedger.cancelledTaskIds.includes(task.id)
                                            ? 'cancelled'
                                            : progressLedger.blockedTaskIds.includes(task.id)
                                              ? 'blocked'
                                              : 'pending'
                                    const canRetry =
                                      taskStatus === 'failed' || taskStatus === 'cancelled'
                                    return (
                                      <div
                                        key={task.id}
                                        className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1"
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span
                                            className={cn(
                                              'h-1.5 w-1.5 rounded-full shrink-0',
                                              taskStatus === 'completed'
                                                ? 'bg-emerald-500'
                                                : taskStatus === 'running'
                                                  ? 'bg-indigo-500'
                                                  : taskStatus === 'failed'
                                                    ? 'bg-red-500'
                                                    : taskStatus === 'cancelled'
                                                      ? 'bg-orange-400'
                                                      : taskStatus === 'blocked'
                                                        ? 'bg-neutral-400'
                                                        : 'bg-neutral-300',
                                            )}
                                          />
                                          <span className="truncate text-[11px] text-neutral-700">
                                            {task.title}
                                          </span>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                          <span
                                            className={cn(
                                              'text-[10px] font-medium',
                                              taskStatus === 'completed'
                                                ? 'text-emerald-600'
                                                : taskStatus === 'failed'
                                                  ? 'text-red-600'
                                                  : taskStatus === 'cancelled'
                                                    ? 'text-orange-500'
                                                    : taskStatus === 'running'
                                                      ? 'text-indigo-600'
                                                      : 'text-neutral-500',
                                            )}
                                          >
                                            {taskStatus}
                                          </span>
                                          {canRetry && selectedRun && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void retryTask(selectedRun.id, task.id)
                                              }
                                              disabled={retryingTaskId === task.id}
                                              className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                                            >
                                              {retryingTaskId === task.id ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                              ) : (
                                                <RefreshCw className="h-3 w-3" />
                                              )}
                                              重试
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Validation / Test Results Panel */}
                  {(() => {
                    const testResults = blackboardEntries.filter(
                      (e) => e.value.schemaType === 'test_result',
                    )
                    if (testResults.length === 0) return null
                    return (
                      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                        <div className="mb-4 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <ShieldAlert className="h-4 w-4 text-blue-600" />
                            <h3 className="text-sm font-semibold">Validation 结果</h3>
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                              {testResults.length} 条
                            </span>
                          </div>
                        </div>
                        <div className="space-y-2">
                          {testResults.map((entry) => {
                            const val = entry.value as unknown as {
                              command: string
                              status: 'passed' | 'failed' | 'skipped'
                              outputSummary: string
                            }
                            const statusConfig = {
                              passed: {
                                icon: CheckCircle2,
                                className: 'text-emerald-600 bg-emerald-50',
                              },
                              failed: { icon: XCircle, className: 'text-red-600 bg-red-50' },
                              skipped: {
                                icon: AlertTriangle,
                                className: 'text-amber-600 bg-amber-50',
                              },
                            }
                            const cfg = statusConfig[val.status] ?? statusConfig.skipped
                            const StatusIcon = cfg.icon
                            return (
                              <div
                                key={`${entry.key}:${entry.version}`}
                                className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-3"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <StatusIcon
                                        className={cn('h-4 w-4', cfg.className.split(' ')[0])}
                                      />
                                      <span className="text-xs font-medium text-neutral-800">
                                        {val.command}
                                      </span>
                                      <span
                                        className={cn(
                                          'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                          cfg.className,
                                        )}
                                      >
                                        {val.status}
                                      </span>
                                    </div>
                                    <div className="mt-1.5 text-xs leading-5 text-neutral-600 whitespace-pre-wrap">
                                      {val.outputSummary}
                                    </div>
                                  </div>
                                  <span className="shrink-0 text-[11px] text-neutral-400">
                                    {relativeTime(entry.createdAt, language)}
                                  </span>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}

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
                          <div
                            key={`${entry.key}:${entry.version}`}
                            className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      'rounded px-1.5 py-0.5 text-[11px] font-medium',
                                      blackboardTone(entry).badgeClass,
                                    )}
                                  >
                                    {blackboardTypeLabel(entry.value.schemaType)}
                                  </span>
                                  <span className="truncate font-mono text-[11px] text-neutral-400">
                                    {entry.key}
                                  </span>
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
                              {entry.taskId && (
                                <span className="rounded bg-white px-1.5 py-0.5">
                                  task:{entry.taskId.slice(0, 8)}
                                </span>
                              )}
                              {entry.agentId && (
                                <span className="rounded bg-white px-1.5 py-0.5">
                                  agent:{entry.agentId.slice(0, 8)}
                                </span>
                              )}
                              <span className="rounded bg-white px-1.5 py-0.5">
                                v{entry.version}
                              </span>
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
                        {events.map((event, index) => (
                          <li
                            key={`${event.type}:${event.timestamp ?? index}:${index}`}
                            className="relative flex gap-3"
                          >
                            <div
                              className={cn(
                                'z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border bg-white',
                                eventTone(event).dotClass,
                              )}
                            >
                              <TimelineIcon event={event} />
                            </div>
                            <div className="min-w-0 flex-1 rounded-lg border border-neutral-100 bg-[#fbfbf8] px-3 py-2">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-neutral-800">
                                    {eventTitle(event)}
                                  </div>
                                  <div className="mt-0.5 text-xs leading-5 text-neutral-500">
                                    {eventSummary(event)}
                                  </div>
                                </div>
                                <span className="shrink-0 text-[11px] text-neutral-400">
                                  {relativeTime(agUiEventDate(event), language)}
                                </span>
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-neutral-500">
                                {agUiTaskId(event) && (
                                  <span className="rounded bg-white px-1.5 py-0.5">
                                    task:{agUiTaskId(event)!.slice(0, 8)}
                                  </span>
                                )}
                                {event.runId && (
                                  <span className="rounded bg-white px-1.5 py-0.5">
                                    run:{event.runId.slice(0, 8)}
                                  </span>
                                )}
                                {event.name && (
                                  <span
                                    className={cn(
                                      'rounded px-1.5 py-0.5',
                                      eventTone(event).badgeClass,
                                    )}
                                  >
                                    {event.name}
                                  </span>
                                )}
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
                        {conflicts.map((c, idx) => {
                          const isResolving = resolvingConflictFile === c.filePath
                          const canAct =
                            c.resolution === 'needs-human' ||
                            c.resolution === 'llm-resolved' ||
                            c.resolution === 'auto-merged'
                          return (
                            <div
                              key={idx}
                              className="rounded-lg border border-neutral-200 bg-[#fbfbf8] p-4"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-mono text-xs text-neutral-600">
                                  {c.filePath}
                                </span>
                                <ConflictResolutionBadge resolution={c.resolution} />
                              </div>
                              {c.notes && (
                                <p className="mt-2 text-xs leading-5 text-neutral-500">{c.notes}</p>
                              )}
                              {c.variants.length > 0 && (
                                <div className="mt-3 space-y-2">
                                  <div className="text-[11px] font-medium text-neutral-500">
                                    各 Agent 修改：
                                  </div>
                                  {c.variants.map((v, vidx) => (
                                    <div
                                      key={vidx}
                                      className="rounded border border-neutral-200 bg-white"
                                    >
                                      <div className="flex items-center gap-2 border-b border-neutral-100 px-2 py-1.5">
                                        <span className="text-xs font-medium text-neutral-700">
                                          {v.agentName}
                                        </span>
                                        <span className="text-[10px] text-neutral-400">
                                          {v.agentId.slice(0, 8)}
                                        </span>
                                      </div>
                                      {v.diff && (
                                        <div className="max-h-40 overflow-auto p-2">
                                          <SimpleDiffLines diff={v.diff} />
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {c.mergedContent && (
                                <div className="mt-3">
                                  <div className="text-[11px] font-medium text-emerald-700">
                                    合并结果
                                  </div>
                                  <pre className="mt-1 max-h-40 overflow-auto rounded border border-emerald-100 bg-emerald-50/40 p-2 text-[11px] leading-4 text-neutral-700">
                                    {c.mergedContent.slice(0, 1200)}
                                    {c.mergedContent.length > 1200 && '...'}
                                  </pre>
                                </div>
                              )}
                              {canAct && selectedRun && (
                                <div className="mt-3">
                                  {!isResolving ? (
                                    <div className="flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setResolvingConflictFile(c.filePath)
                                          setResolveMergedContent(c.mergedContent || '')
                                          setResolveNotes('')
                                        }}
                                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                                      >
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        确认合并
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setResolvingConflictFile(c.filePath)
                                          setResolveMergedContent(c.mergedContent || '')
                                          setResolveNotes('')
                                        }}
                                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                        修改决议
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void resolveConflict(
                                            selectedRun.id,
                                            c.filePath,
                                            'rejected',
                                          )
                                        }
                                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-medium text-red-700 hover:bg-red-100"
                                      >
                                        <XCircle className="h-3.5 w-3.5" />
                                        拒绝合并
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3">
                                      <label className="block text-[11px] font-medium text-neutral-700">
                                        最终合并内容
                                      </label>
                                      <textarea
                                        value={resolveMergedContent}
                                        onChange={(e) => setResolveMergedContent(e.target.value)}
                                        rows={4}
                                        className="w-full rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[11px] leading-4 text-neutral-700 outline-none focus:border-neutral-400"
                                      />
                                      <label className="block text-[11px] font-medium text-neutral-700">
                                        备注
                                      </label>
                                      <input
                                        value={resolveNotes}
                                        onChange={(e) => setResolveNotes(e.target.value)}
                                        className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] text-neutral-700 outline-none focus:border-neutral-400"
                                        placeholder="说明决议原因..."
                                      />
                                      <div className="flex flex-wrap gap-2 pt-1">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void resolveConflict(
                                              selectedRun.id,
                                              c.filePath,
                                              'overridden',
                                            )
                                          }
                                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800"
                                        >
                                          保存决议
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setResolvingConflictFile(null)
                                            setResolveNotes('')
                                            setResolveMergedContent('')
                                          }}
                                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                                        >
                                          取消
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
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
                                <span className="text-xs font-medium text-neutral-700">
                                  {logTypeLabel(log.type)}
                                </span>
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

function TimelineIcon({ event }: { event: AgUiRunEvent }) {
  if (event.type === 'RUN_ERROR') return <XCircle className="h-3.5 w-3.5 text-red-500" />
  if (event.type === 'RUN_FINISHED')
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
  if (event.type === 'STEP_STARTED') return <PlayCircle className="h-3.5 w-3.5 text-indigo-500" />
  if (event.type === 'STEP_FINISHED')
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
  if (event.name?.includes('artifact')) return <FileDiff className="h-3.5 w-3.5 text-blue-500" />
  if (event.name?.includes('blackboard'))
    return <GitBranch className="h-3.5 w-3.5 text-emerald-500" />
  if (event.name?.includes('run.status'))
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
  if (event.name?.includes('task.status'))
    return <PlayCircle className="h-3.5 w-3.5 text-indigo-500" />
  return <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
}

function eventTone(event: AgUiRunEvent) {
  const status = payloadText(event.value?.status) || event.type
  if (event.type === 'RUN_ERROR' || status === 'failed') {
    return { dotClass: 'border-red-100 text-red-500', badgeClass: 'bg-red-50 text-red-700' }
  }
  if (status === 'cancelled' || status === 'blocked') {
    return { dotClass: 'border-amber-100 text-amber-500', badgeClass: 'bg-amber-50 text-amber-700' }
  }
  if (event.type === 'RUN_FINISHED' || status === 'done' || status === 'completed') {
    return {
      dotClass: 'border-emerald-100 text-emerald-500',
      badgeClass: 'bg-emerald-50 text-emerald-700',
    }
  }
  return {
    dotClass: 'border-indigo-100 text-indigo-500',
    badgeClass: 'bg-indigo-50 text-indigo-700',
  }
}

function eventTitle(event: AgUiRunEvent) {
  if (event.type === 'RUN_STARTED') return '运行开始'
  if (event.type === 'RUN_FINISHED')
    return payloadText(event.result?.status) === 'cancelled' ? '运行取消' : '运行完成'
  if (event.type === 'RUN_ERROR') return '运行失败'
  if (event.type === 'STEP_STARTED') return '成员任务开始'
  if (event.type === 'STEP_FINISHED') return '成员任务结束'
  if (event.name === 'agenthub.task.status')
    return taskStatusTitle(payloadText(event.value?.status))
  if (event.name === 'agenthub.artifact.created') return '产物生成'
  if (event.name === 'agenthub.blackboard.written') return '黑板写入'
  if (event.name === 'agenthub.run.status') return runStatusTitle(payloadText(event.value?.status))
  return event.name ?? event.type
}

function eventSummary(event: AgUiRunEvent) {
  const value = event.value ?? {}
  const taskTitle = payloadText(value.taskTitle)
  const agentName = payloadText(value.agentName)
  const summary = payloadText(value.summary)
  const status = payloadText(value.status)

  if (event.type === 'STEP_STARTED')
    return event.stepName ? `${event.stepName} 开始执行。` : '成员任务开始执行。'
  if (event.type === 'STEP_FINISHED')
    return event.stepName ? `${event.stepName} 执行结束。` : '成员任务执行结束。'
  if (event.type === 'RUN_STARTED') return 'Orchestrator 已进入执行链路。'
  if (event.type === 'RUN_FINISHED')
    return status === 'cancelled' ? '本次运行已取消。' : '本次运行已完成。'
  if (event.type === 'RUN_ERROR') return event.message || '运行失败。'
  if (event.name === 'agenthub.task.status') {
    const prefix = agentName || 'Agent'
    if (status === 'running') return `${prefix} 正在处理${taskTitle ? `：${taskTitle}` : '任务'}。`
    if (status === 'done') return `${prefix} 完成${taskTitle ? `：${taskTitle}` : '任务'}。`
    if (status === 'failed') return `${prefix} 执行失败。`
    if (status === 'pending') return `${taskTitle || '任务'} 已入队等待执行。`
    if (status === 'cancelled') return `${taskTitle || '任务'} 已取消。`
  }
  if (event.name === 'agenthub.artifact.created') {
    const artifact = asRecord(value.artifact)
    const filePath =
      payloadText(value.filePath) || payloadText(artifact?.filePath) || payloadText(artifact?.path)
    const title = payloadText(value.title) || payloadText(artifact?.title)
    return `${title || taskTitle || '产物'}${filePath ? `：${filePath}` : ''}`
  }
  if (event.name === 'agenthub.blackboard.written')
    return summary || `${taskTitle || '任务'} 写入了共享黑板。`
  if (event.name === 'agenthub.run.status') return summary || runStatusTitle(status)
  return event.name ?? event.type
}

function taskStatusTitle(status: string) {
  const map: Record<string, string> = {
    pending: '任务入队',
    running: '任务执行中',
    done: '任务完成',
    failed: '任务失败',
    cancelled: '任务取消',
    blocked: '任务受阻',
  }
  return map[status] ?? '任务状态更新'
}

function runStatusTitle(status: string) {
  const map: Record<string, string> = {
    planning: '规划中',
    running: '运行中',
    synthesizing: '正在汇总',
    completed: '运行完成',
    failed: '运行失败',
    cancelled: '运行取消',
  }
  return map[status] ?? '运行状态更新'
}

function agUiTaskId(event: AgUiRunEvent) {
  return payloadText(event.value?.taskId)
}

function agUiEventDate(event: AgUiRunEvent) {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? new Date(event.timestamp)
    : new Date()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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
    const changedFiles = Array.isArray(value.changedFiles)
      ? value.changedFiles.filter((item): item is string => typeof item === 'string')
      : []
    return changedFiles.length > 0
      ? changedFiles.slice(0, 3).join(', ')
      : payloadText(value.branchName)
  }
  if (value.schemaType === 'decision') return payloadText(value.decision)
  if (value.schemaType === 'risk') return payloadText(value.risk)
  if (value.schemaType === 'fact') return payloadText(value.fact)
  if (value.schemaType === 'test_result') {
    return [payloadText(value.status), payloadText(value.command)].filter(Boolean).join(' · ')
  }
  return ''
}

function StatusBadge({
  status,
  large = false,
}: {
  status: OrchestratorRunListItem['status']
  large?: boolean
}) {
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
        large && 'px-3 py-1 text-sm',
      )}
    >
      {cfg.text}
    </span>
  )
}

function isCancellableRun(status: OrchestratorRunListItem['status']) {
  return status === 'planning' || status === 'running' || status === 'synthesizing'
}

function SimpleDiffLines({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/)
  return (
    <div className="space-y-0 text-[11px] leading-4">
      {lines.map((line, i) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return (
            <div key={i} className="flex gap-2 bg-emerald-50 text-emerald-900">
              <span className="w-4 shrink-0 text-emerald-500">+</span>
              <span className="break-all">{line.slice(1)}</span>
            </div>
          )
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return (
            <div key={i} className="flex gap-2 bg-red-50 text-red-900">
              <span className="w-4 shrink-0 text-red-500">-</span>
              <span className="break-all">{line.slice(1)}</span>
            </div>
          )
        }
        if (line.startsWith('@@')) {
          return (
            <div key={i} className="bg-blue-50 text-blue-700">
              {line}
            </div>
          )
        }
        return (
          <div key={i} className="flex gap-2 text-neutral-600">
            <span className="w-4 shrink-0"> </span>
            <span className="break-all">{line}</span>
          </div>
        )
      })}
    </div>
  )
}

function ConflictResolutionBadge({ resolution }: { resolution: ConflictReportItem['resolution'] }) {
  const map: Record<string, { text: string; className: string }> = {
    'auto-merged': { text: '自动合并', className: 'bg-emerald-50 text-emerald-700' },
    'llm-resolved': { text: 'LLM 解决', className: 'bg-blue-50 text-blue-700' },
    'needs-human': { text: '需人工介入', className: 'bg-red-50 text-red-700' },
    'human-approved': { text: '已确认', className: 'bg-emerald-100 text-emerald-800' },
    'human-rejected': { text: '已拒绝', className: 'bg-red-100 text-red-800' },
    'human-overridden': { text: '已覆盖', className: 'bg-amber-100 text-amber-800' },
  }
  const cfg = map[resolution] ?? { text: resolution, className: 'bg-neutral-100 text-neutral-600' }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        cfg.className,
      )}
    >
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
        <p className="mt-2 text-xs leading-5 text-neutral-500">
          左侧列表展示所有 Orchestrator 运行历史，点击可查看详情、冲突报告和执行日志。
        </p>
      </div>
    </div>
  )
}
