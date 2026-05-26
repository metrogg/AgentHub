import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Filter,
  GitBranch,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import { api, type ExecutionLog, type OrchestratorRunListItem } from '../lib/api'
import { cn } from '../lib/utils'

export default function ExecutionLogsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialRunId = searchParams.get('runId') || ''

  const [logs, setLogs] = useState<ExecutionLog[]>([])
  const [runs, setRuns] = useState<OrchestratorRunListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const [runIdFilter, setRunIdFilter] = useState(initialRunId)
  const [agentIdFilter, setAgentIdFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<ExecutionLog['type'] | ''>('')
  const [query, setQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  async function refreshData() {
    setLoading(true)
    setMessage('')
    try {
      const [runsResult] = await Promise.all([api.listOrchestratorRuns()])
      setRuns(runsResult.items)

      let allLogs: ExecutionLog[] = []
      if (runIdFilter) {
        const logsResult = await api.getOrchestratorRunLogs(runIdFilter)
        allLogs = logsResult.items
      } else {
        // Fetch logs for all runs (limit to last 20 runs to avoid overload)
        const recentRuns = runsResult.items.slice(0, 20)
        const logResults = await Promise.all(
          recentRuns.map((r) =>
            api.getOrchestratorRunLogs(r.id).catch(() => ({ items: [] }))
          )
        )
        allLogs = logResults.flatMap((r) => r.items)
        allLogs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      }
      setLogs(allLogs)
    } catch (error: any) {
      setMessage(error?.message || '读取执行日志失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshData()
  }, [runIdFilter])

  const filteredLogs = useMemo(() => {
    let result = [...logs]
    if (agentIdFilter) {
      result = result.filter((l) => l.agentId.toLowerCase().includes(agentIdFilter.toLowerCase()))
    }
    if (typeFilter) {
      result = result.filter((l) => l.type === typeFilter)
    }
    if (query.trim()) {
      const k = query.trim().toLowerCase()
      result = result.filter(
        (l) =>
          l.agentId.toLowerCase().includes(k) ||
          l.taskId?.toLowerCase().includes(k) ||
          JSON.stringify(l.input).toLowerCase().includes(k) ||
          JSON.stringify(l.output).toLowerCase().includes(k)
      )
    }
    // Newest first
    return result.reverse()
  }, [logs, agentIdFilter, typeFilter, query])

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runOptions = useMemo(
    () => runs.map((r) => ({ id: r.id, label: `${r.workspaceName} · ${r.sessionTitle}` })),
    [runs]
  )

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/orchestrator-runs')}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
              aria-label="返回运行历史"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <Clock className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-semibold">执行追踪日志</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">多 Agent 协作执行过程全链路记录</span>
          </div>
          <button
            type="button"
            onClick={refreshData}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f5f1]">
          <div className="flex flex-col gap-4 p-5">
            {/* Filters */}
            <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
                  <label className="text-xs text-neutral-500">运行记录</label>
                  <select
                    value={runIdFilter}
                    onChange={(e) => {
                      const val = e.target.value
                      setRunIdFilter(val)
                      if (val) {
                        setSearchParams({ runId: val })
                      } else {
                        setSearchParams({})
                      }
                    }}
                    className="h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-indigo-500"
                  >
                    <option value="">全部运行记录</option>
                    {runOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex min-w-[8rem] flex-col gap-1.5">
                  <label className="text-xs text-neutral-500">Agent ID</label>
                  <input
                    value={agentIdFilter}
                    onChange={(e) => setAgentIdFilter(e.target.value)}
                    placeholder="过滤 Agent"
                    className="h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none placeholder:text-neutral-400 focus:border-indigo-500"
                  />
                </div>
                <div className="flex min-w-[8rem] flex-col gap-1.5">
                  <label className="text-xs text-neutral-500">日志类型</label>
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as ExecutionLog['type'] | '')}
                    className="h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-indigo-500"
                  >
                    <option value="">全部类型</option>
                    <option value="llm_call">LLM 调用</option>
                    <option value="tool_call">工具调用</option>
                    <option value="blackboard_read">黑板读取</option>
                    <option value="blackboard_write">黑板写入</option>
                    <option value="error">错误</option>
                    <option value="task_start">任务开始</option>
                    <option value="task_end">任务结束</option>
                  </select>
                </div>
                <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
                  <label className="text-xs text-neutral-500">搜索</label>
                  <div className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3">
                    <Search className="h-4 w-4 text-neutral-400" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索 Agent / Task / 内容"
                      className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                    />
                    {query && (
                      <button type="button" onClick={() => setQuery('')} className="text-neutral-400 hover:text-neutral-600">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAgentIdFilter('')
                    setTypeFilter('')
                    setQuery('')
                  }}
                  className="inline-flex h-10 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
                >
                  <Filter className="h-4 w-4" />
                  重置
                </button>
              </div>
              {message && (
                <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">{message}</div>
              )}
            </div>

            {/* Logs table */}
            <div className="rounded-xl border border-neutral-200 bg-white shadow-sm">
              {loading && logs.length === 0 ? (
                <div className="grid h-48 place-items-center text-sm text-neutral-400">
                  <span className="flex flex-col items-center gap-2">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    加载执行日志
                  </span>
                </div>
              ) : filteredLogs.length === 0 ? (
                <div className="grid h-48 place-items-center text-sm text-neutral-400">
                  {logs.length === 0 ? '暂无执行日志' : '没有匹配的记录'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 bg-[#fbfbf8]">
                        <th className="w-10 px-4 py-3"></th>
                        <th className="px-4 py-3 text-xs font-medium text-neutral-500">类型</th>
                        <th className="px-4 py-3 text-xs font-medium text-neutral-500">Agent</th>
                        <th className="px-4 py-3 text-xs font-medium text-neutral-500">Task</th>
                        <th className="px-4 py-3 text-xs font-medium text-neutral-500">耗时</th>
                        <th className="px-4 py-3 text-xs font-medium text-neutral-500">时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {filteredLogs.map((log) => {
                        const expanded = expandedIds.has(log.id)
                        return (
                          <>
                            <tr
                              key={log.id}
                              onClick={() => toggleExpand(log.id)}
                              className="cursor-pointer transition hover:bg-neutral-50"
                            >
                              <td className="px-4 py-3">
                                {expanded ? (
                                  <ChevronDown className="h-4 w-4 text-neutral-400" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-neutral-400" />
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <LogTypeIcon type={log.type} />
                                  <LogTypeBadge type={log.type} />
                                </div>
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                                {log.agentId.slice(0, 12)}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                                {log.taskId ? log.taskId.slice(0, 12) : '-'}
                              </td>
                              <td className="px-4 py-3 text-xs text-neutral-500">
                                {log.durationMs != null ? `${log.durationMs}ms` : '-'}
                              </td>
                              <td className="px-4 py-3 text-xs text-neutral-400">
                                {new Date(log.createdAt).toLocaleTimeString('zh-CN')}
                              </td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td colSpan={6} className="bg-[#fbfbf8] px-4 py-4">
                                  <LogDetail log={log} />
                                </td>
                              </tr>
                            )}
                          </>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
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

function LogTypeBadge({ type }: { type: ExecutionLog['type'] }) {
  const map: Record<string, { text: string; className: string }> = {
    llm_call: { text: 'LLM', className: 'bg-purple-50 text-purple-700' },
    tool_call: { text: '工具', className: 'bg-blue-50 text-blue-700' },
    blackboard_read: { text: '读黑板', className: 'bg-emerald-50 text-emerald-700' },
    blackboard_write: { text: '写黑板', className: 'bg-teal-50 text-teal-700' },
    error: { text: '错误', className: 'bg-red-50 text-red-700' },
    task_start: { text: '开始', className: 'bg-neutral-100 text-neutral-600' },
    task_end: { text: '结束', className: 'bg-neutral-100 text-neutral-600' },
  }
  const cfg = map[type] ?? { text: type, className: 'bg-neutral-100 text-neutral-600' }
  return (
    <span className={cn('inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium', cfg.className)}>
      {cfg.text}
    </span>
  )
}

function LogDetail({ log }: { log: ExecutionLog }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">
        <DetailField label="Run ID" value={log.runId} />
        <DetailField label="Session ID" value={log.sessionId} />
        <DetailField label="Agent ID" value={log.agentId} />
        <DetailField label="Task ID" value={log.taskId ?? '-'} />
        <DetailField label="类型" value={log.type} />
        <DetailField label="耗时" value={log.durationMs != null ? `${log.durationMs}ms` : '-'} />
        <DetailField
          label="Token 用量"
          value={log.tokenUsage ? JSON.stringify(log.tokenUsage) : '-'}
        />
        <DetailField
          label="时间"
          value={new Date(log.createdAt).toLocaleString('zh-CN')}
        />
      </div>
      {(log.input != null || log.output != null) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {log.input != null && (
            <div>
              <div className="mb-1 text-xs font-medium text-neutral-500">Input</div>
              <pre className="max-h-60 overflow-auto rounded-lg border border-neutral-200 bg-white p-3 text-[11px] leading-4 text-neutral-700">
                {typeof log.input === 'string' ? log.input : JSON.stringify(log.input, null, 2)}
              </pre>
            </div>
          )}
          {log.output != null && (
            <div>
              <div className="mb-1 text-xs font-medium text-neutral-500">Output</div>
              <pre className="max-h-60 overflow-auto rounded-lg border border-neutral-200 bg-white p-3 text-[11px] leading-4 text-neutral-700">
                {typeof log.output === 'string' ? log.output : JSON.stringify(log.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-white px-2.5 py-1.5">
      <div className="text-[11px] text-neutral-400">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-700">{value}</div>
    </div>
  )
}
