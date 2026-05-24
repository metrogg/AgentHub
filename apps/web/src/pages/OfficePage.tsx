import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  BriefcaseBusiness,
  FolderOpen,
  Loader2,
  MessageSquare,
  PanelLeft,
  Play,
  RefreshCw,
  TimerReset,
  Users,
  X,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { api, type Session, type TaskStatus, type WorkspaceAgent, type WorkspaceTask } from '../lib/api'
import { cn, relativeTime } from '../lib/utils'
import { useWorkspaceStore } from '../stores/workspaceStore'

type OfficeSeat = {
  id: string
  x: number
  y: number
  agent?: WorkspaceAgent
  task?: WorkspaceTask
  session?: Session
  state: 'idle' | 'running' | 'done' | 'pending'
}

const seatLayout = [
  { x: 52, y: 24 },
  { x: 76, y: 26 },
  { x: 52, y: 50 },
  { x: 76, y: 52 },
  { x: 52, y: 76 },
  { x: 76, y: 78 },
]

export default function OfficePage() {
  const navigate = useNavigate()
  const { workspaces, currentId, agents, tasks, loadingList, loadingDetail, fetchList, selectWorkspace, dispatchTask, openGroupSession } =
    useWorkspaceStore()
  const [sessions, setSessions] = useState<Session[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)

  const workspace = workspaces.find((item) => item.id === currentId) ?? null
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const assignedTasks = useMemo(() => {
    const byAgent = new Map<string, WorkspaceTask>()
    for (const task of tasks) {
      if (!task.agentId) continue
      const previous = byAgent.get(task.agentId)
      if (!previous || taskRank(task) > taskRank(previous)) byAgent.set(task.agentId, task)
    }
    return byAgent
  }, [tasks])

  const seats = useMemo<OfficeSeat[]>(() => {
    const orderedAgents = [...agents].sort((a, b) => a.orderIdx - b.orderIdx)
    return orderedAgents.slice(0, seatLayout.length).map((agent, index) => {
      const position = seatLayout[index]
      const task = assignedTasks.get(agent.id)
      const session = task?.sessionId ? sessionById.get(task.sessionId) : undefined
      return {
        id: agent.id,
        ...position,
        agent,
        task,
        session,
        state: task?.status ?? 'idle',
      }
    })
  }, [agents, assignedTasks, sessionById])

  const running = tasks.filter((task) => task.status === 'running')
  const done = tasks.filter((task) => task.status === 'done')
  const pending = tasks.filter((task) => task.status === 'pending')
  const activeSessions = sessions.filter((session) => session.workspaceId === currentId)
  const recentActivity = [...tasks]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 6)

  useEffect(() => {
    let cancelled = false
    fetchList().then(() => {
      const state = useWorkspaceStore.getState()
      if (!cancelled && !state.currentId && state.workspaces[0]) void state.selectWorkspace(state.workspaces[0].id)
    })
    return () => {
      cancelled = true
    }
  }, [fetchList])

  useEffect(() => {
    void refreshOffice()
    const timer = window.setInterval(() => {
      void refreshOffice({ quiet: true })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [currentId])

  async function refreshOffice(options: { quiet?: boolean } = {}) {
    if (!options.quiet) setRefreshing(true)
    try {
      const { items } = await api.listSessions()
      setSessions(items)
      if (currentId) await selectWorkspace(currentId)
    } finally {
      if (!options.quiet) setRefreshing(false)
    }
  }

  async function openGroupChat() {
    if (!currentId) return
    const sessionId = await openGroupSession()
    if (sessionId) navigate(`/chat/${sessionId}`)
  }

  async function dispatch(task: WorkspaceTask) {
    setBusyTaskId(task.id)
    try {
      const sessionId = await dispatchTask(task.id)
      await refreshOffice({ quiet: true })
      if (sessionId) navigate(`/chat/${sessionId}`)
    } finally {
      setBusyTaskId(null)
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#f6f6f2] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="侧栏">
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">办公室</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={currentId ?? ''}
              onChange={(event) => void selectWorkspace(event.target.value || null)}
              className="h-9 max-w-64 rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none"
            >
              <option value="">选择工作区</option>
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void refreshOffice()}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
            >
              <RefreshCw className={cn('h-4 w-4', (refreshing || loadingList || loadingDetail) && 'animate-spin')} />
              刷新
            </button>
            <button
              type="button"
              onClick={openGroupChat}
              disabled={!currentId}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200"
            >
              <MessageSquare className="h-4 w-4" />
              群聊
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_24rem]">
          <section className="relative min-w-0 overflow-hidden">
            <OfficeScene
              seats={seats}
              workspaceName={workspace?.name ?? 'Agent Office'}
              stats={{
                activeSessions: activeSessions.length,
                done: done.length,
                pending: pending.length,
                running: running.length,
                totalTasks: tasks.length,
              }}
              onOpenSession={(id) => navigate(`/chat/${id}`)}
            />
          </section>

          <aside className="min-h-0 overflow-y-auto border-l border-neutral-200 bg-white px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-normal">Agent 办公室</h1>
                <p className="mt-1 text-sm text-neutral-500">{workspace?.goal || '观察团队成员、任务状态和最近会话。'}</p>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-neutral-950 text-white">
                <BriefcaseBusiness className="h-5 w-5" />
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 divide-x divide-neutral-200 rounded-2xl bg-neutral-50 px-2 py-4">
              <Metric label="进行中" value={running.length} />
              <Metric label="已完成" value={done.length} />
              <Metric label="总任务" value={tasks.length} />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2">
              <StatusPill icon={<Users className="h-4 w-4" />} label="Agent" value={agents.length} />
              <StatusPill icon={<MessageSquare className="h-4 w-4" />} label="会话" value={activeSessions.length} />
              <StatusPill icon={<TimerReset className="h-4 w-4" />} label="待处理" value={pending.length} />
              <StatusPill icon={<Activity className="h-4 w-4" />} label="运行中" value={running.length} />
            </div>

            {workspace?.projectPath && (
              <div className="mt-5 flex items-start gap-2 rounded-2xl border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-500">
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
                <div className="min-w-0">
                  <div className="font-medium text-neutral-900">项目目录</div>
                  <div className="mt-1 break-all font-mono">{workspace.projectPath}</div>
                </div>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between">
              <h2 className="text-sm font-semibold">活动明细</h2>
              <span className="text-xs text-neutral-400">自动刷新 5s</span>
            </div>
            <div className="mt-3 space-y-2">
              {recentActivity.map((task) => {
                const agent = task.agentId ? agentById.get(task.agentId) : null
                return (
                  <div key={task.id} className="rounded-2xl border border-neutral-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-neutral-950">{task.title}</div>
                        <div className="mt-1 text-xs text-neutral-500">
                          {agent?.name ?? '未分配'} · {taskStatusLabel(task.status)} · {relativeTime(task.updatedAt)}
                        </div>
                      </div>
                      <TaskStatusDot status={task.status} />
                    </div>
                    <div className="mt-3 flex gap-2">
                      {task.sessionId && (
                        <button
                          type="button"
                          onClick={() => navigate(`/chat/${task.sessionId}`)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          查看会话
                        </button>
                      )}
                      {!task.sessionId && (
                        <button
                          type="button"
                          onClick={() => dispatch(task)}
                          disabled={busyTaskId === task.id}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-950 px-2.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-300"
                        >
                          {busyTaskId === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                          分派
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {!recentActivity.length && (
                <div className="rounded-2xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
                  还没有任务活动
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}

function OfficeScene({
  seats,
  stats,
  workspaceName,
  onOpenSession,
}: {
  seats: OfficeSeat[]
  stats: {
    activeSessions: number
    done: number
    pending: number
    running: number
    totalTasks: number
  }
  workspaceName: string
  onOpenSession: (sessionId: string) => void
}) {
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null)
  const selectedSeat = seats.find((seat) => seat.id === selectedSeatId && seat.agent) ?? null

  return (
    <div className="office-scene relative h-full min-h-[680px] overflow-hidden">
      <div className="absolute left-1/2 top-6 z-10 -translate-x-1/2 text-center">
        <div className="text-lg font-semibold tracking-normal">{workspaceName} 办公室</div>
        <div className="mt-1 text-xs text-neutral-400">Agent activity monitor</div>
      </div>

      <div className="office-hud absolute right-8 top-7 z-20 hidden w-72 rounded-2xl border border-white/70 bg-white/80 p-3 shadow-[0_18px_42px_rgba(15,23,42,0.08)] backdrop-blur-xl 2xl:block">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-500">实时监控</span>
          <span className="office-live-dot inline-flex items-center gap-1 text-[11px] text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            live
          </span>
        </div>
        <div className="mt-3 grid grid-cols-4 divide-x divide-neutral-200 rounded-xl bg-neutral-50 py-2 text-center">
          <MiniMetric label="运行" value={stats.running} />
          <MiniMetric label="待办" value={stats.pending} />
          <MiniMetric label="完成" value={stats.done} />
          <MiniMetric label="会话" value={stats.activeSessions} />
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-100">
          <div
            className="office-progress h-full rounded-full bg-neutral-950"
            style={{ width: `${stats.totalTasks ? Math.max(8, Math.round((stats.done / stats.totalTasks) * 100)) : 8}%` }}
          />
        </div>
      </div>

      <div className="office-data-lane absolute left-[39%] top-[19%] h-px w-[44%]">
        <span />
        <span />
        <span />
      </div>
      <div className="office-data-lane office-data-lane-slow absolute left-[38%] top-[48%] h-px w-[45%]">
        <span />
        <span />
        <span />
      </div>

      <div className="office-pantry absolute left-[3%] top-[9%] h-[18%] w-[32%] bg-white shadow-[0_30px_60px_rgba(15,23,42,0.08)]">
        <div className="absolute left-6 top-1/2 h-8 w-[74%] -translate-y-1/2 bg-neutral-100" />
        {Array.from({ length: 7 }).map((_, index) => (
          <span
            key={index}
            className="office-token-cup absolute top-[42%] h-5 w-5 rounded-full bg-[linear-gradient(180deg,#e8c09a,#b46b3f)] shadow"
            style={{ left: `${12 + index * 7}%`, animationDelay: `${index * 120}ms` }}
          />
        ))}
        <span className="office-steam left-[14%]" />
        <span className="office-steam left-[21%]" style={{ animationDelay: '450ms' }} />
        <div className="absolute right-8 top-8 h-14 w-14 rounded-sm bg-neutral-300 shadow-inner" />
      </div>

      <div className="office-quiet-room absolute bottom-[3%] left-[3%] h-[24%] w-[32%] bg-white shadow-[0_30px_60px_rgba(15,23,42,0.07)]">
        <div className="absolute bottom-8 left-16 h-20 w-20 rounded-b-[2rem] border-[12px] border-neutral-200 bg-white" />
        <div className="absolute left-28 top-10 h-7 w-7 rounded-sm bg-neutral-100 shadow" />
      </div>

      {seats.map((seat) => (
        <OfficeSeatView key={seat.id} seat={seat} onInspect={() => setSelectedSeatId(seat.id)} />
      ))}

      {selectedSeat?.agent && (
        <AgentOverviewCard
          seat={selectedSeat}
          onClose={() => setSelectedSeatId(null)}
          onOpenSession={selectedSeat.session ? () => onOpenSession(selectedSeat.session!.id) : undefined}
        />
      )}
    </div>
  )
}

function OfficeSeatView({ seat, onInspect }: { seat: OfficeSeat; onInspect: () => void }) {
  const active = seat.state === 'running'
  const animated = seat.state === 'running' || seat.state === 'pending'
  const seatStyle = {
    left: `${seat.x}%`,
    top: `${seat.y}%`,
    ['--agent-color' as string]: seat.agent?.color ?? '#111827',
  } satisfies CSSProperties

  return (
    <button
      type="button"
      onClick={onInspect}
      disabled={!seat.agent}
      className={cn(
        'office-seat group absolute h-40 w-56 -translate-x-1/2 -translate-y-1/2 text-left transition duration-300',
        seat.state === 'running' && 'office-seat-running',
        seat.state === 'pending' && 'office-seat-pending',
        seat.state === 'done' && 'office-seat-done',
        seat.agent && 'hover:-translate-y-[54%]',
        !seat.agent && 'opacity-45'
      )}
      style={seatStyle}
    >
      <div className="office-desk absolute left-4 top-11 h-16 w-48 bg-white shadow-[0_24px_42px_rgba(15,23,42,0.12)]" />
      <div className="office-monitor absolute left-[4.25rem] top-0 h-11 w-24 rounded-sm bg-neutral-900 shadow">
        <div className={cn('office-monitor-screen h-full rounded-sm', active ? 'bg-[#3b82f6]' : seat.state === 'done' ? 'bg-[#1f2937]' : 'bg-neutral-900')} />
        <span className="office-monitor-scan" />
      </div>
      <div className="absolute left-[5rem] top-11 h-2 w-14 bg-neutral-200" />
      <div className="absolute left-9 top-[5.45rem] h-12 w-10 bg-neutral-100 shadow" />
      <div className="absolute left-28 top-[5.45rem] h-12 w-9 bg-neutral-100 shadow" />
      <div className="office-chair absolute left-[5.25rem] top-[5.1rem] h-14 w-12 bg-neutral-200" />
      {seat.agent && (
        <div className="office-keyboard absolute left-[4.25rem] top-[4.42rem] h-2.5 w-20 rounded-full bg-neutral-100">
          <span />
          <span />
          <span />
        </div>
      )}

      {seat.agent && (
        <>
          <div className={cn('office-agent-body absolute left-[5.25rem] top-[3.2rem] h-14 w-14 rounded-[1.1rem] shadow-lg', active && 'office-agent-working')}>
            <div className="absolute inset-0 rounded-[1.1rem] bg-[var(--agent-color)]" />
            <div className="office-eye office-eye-left" />
            <div className="office-eye office-eye-right" />
            <div className="office-mouth" />
            <div className={cn('office-hand office-hand-left', animated && 'office-hand-type')} />
            <div className={cn('office-hand office-hand-right', animated && 'office-hand-type')} />
          </div>
          <div className="absolute -top-8 left-1/2 w-40 -translate-x-1/2 text-center">
            <div className="truncate text-sm font-semibold text-neutral-950">{seat.agent.name}</div>
            <div className="truncate text-[11px] text-neutral-500">{seat.task?.title ?? seat.agent.role}</div>
          </div>
          <div className="office-status-ring absolute left-[5.02rem] top-[2.98rem] h-[4rem] w-[4rem] rounded-[1.35rem]" />
          {animated && (
            <div className="office-task-packet absolute left-[9rem] top-[2.25rem] rounded-md bg-white px-2 py-1 text-[10px] font-medium text-neutral-600 shadow">
              {seat.state === 'running' ? 'RUN' : 'TODO'}
            </div>
          )}
          <div className="absolute left-7 top-[7.6rem] inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-1 text-[11px] text-neutral-500 shadow">
            <TaskStatusDot status={seat.state === 'idle' ? 'pending' : seat.state} />
            {seat.state === 'idle' ? '空闲' : taskStatusLabel(seat.state)}
          </div>
        </>
      )}
    </button>
  )
}

function AgentOverviewCard({
  onClose,
  onOpenSession,
  seat,
}: {
  onClose: () => void
  onOpenSession?: () => void
  seat: OfficeSeat
}) {
  const agent = seat.agent!
  const x = Math.min(78, Math.max(26, seat.x))
  const y = Math.min(68, Math.max(26, seat.y + 17))
  const tags = overviewTags(agent)

  return (
    <div
      className="office-agent-card absolute z-40 w-[22rem] -translate-x-1/2 rounded-2xl border border-white/80 bg-white/95 p-5 text-left shadow-[0_24px_70px_rgba(15,23,42,0.18)] backdrop-blur-xl"
      style={{ left: `${x}%`, top: `${y}%`, ['--agent-color' as string]: agent.color } as CSSProperties}
      role="dialog"
      aria-label={`${agent.name} 概览`}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
        aria-label="关闭"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-4">
        <div className="relative grid h-20 w-20 shrink-0 place-items-center rounded-full border border-neutral-200 bg-white">
          <div className="relative h-12 w-12 rounded-[1rem] bg-[var(--agent-color)] shadow">
            <div className="absolute left-2.5 top-2 h-3.5 w-3.5 rounded-full bg-neutral-950" />
            <div className="absolute right-2.5 top-2 h-3.5 w-3.5 rounded-full bg-neutral-950" />
            <div className="absolute bottom-2.5 left-2.5 right-2.5 h-1.5 rounded-full bg-white/85" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold tracking-normal text-neutral-950">{agent.name}</h2>
          <div className="mt-1 text-sm text-neutral-600">{agent.role}</div>
          <div className="mt-2 inline-flex items-center gap-1.5 text-sm text-neutral-400">
            <TaskStatusDot status={seat.state === 'idle' ? 'pending' : seat.state} />
            {seat.state === 'idle' ? '空闲中' : taskStatusLabel(seat.state)}
          </div>
        </div>
      </div>

      <div className="my-5 h-px bg-neutral-200" />

      <div>
        <div className="text-xs text-neutral-400">简介:</div>
        <p className="mt-2 text-sm leading-6 text-neutral-700">
          {agent.description || agent.systemPrompt || `${agent.name} 负责${agent.role}相关任务。`}
        </p>
      </div>

      <div className="mt-5">
        <div className="text-xs text-neutral-400">技能:</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className="rounded-lg bg-[#f6eeee] px-2.5 py-1 text-xs text-[#8a5a52]">
              {tag}
            </span>
          ))}
        </div>
      </div>

      {seat.task && (
        <div className="mt-5 rounded-xl bg-neutral-50 px-3 py-2">
          <div className="truncate text-sm font-medium text-neutral-900">{seat.task.title}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{seat.task.description || '当前任务暂无描述'}</div>
        </div>
      )}

      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          <MessageSquare className="h-4 w-4" />
          打开会话
        </button>
      )}
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-2">
      <div className="text-sm font-semibold text-neutral-950">{value}</div>
      <div className="mt-0.5 text-[10px] text-neutral-400">{label}</div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 text-center">
      <div className="text-lg font-semibold text-neutral-950">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function StatusPill({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white px-3 py-2">
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-neutral-50 text-neutral-500">{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-neutral-950">{value}</span>
        <span className="block text-xs text-neutral-400">{label}</span>
      </span>
    </div>
  )
}

function TaskStatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full',
        status === 'running' ? 'bg-blue-500' : status === 'done' ? 'bg-emerald-500' : 'bg-neutral-300'
      )}
    />
  )
}

function taskRank(task: WorkspaceTask) {
  if (task.status === 'running') return 4
  if (task.status === 'pending') return 3
  if (task.status === 'done') return 2
  return 1
}

function taskStatusLabel(status: TaskStatus | OfficeSeat['state']) {
  if (status === 'running') return '进行中'
  if (status === 'done') return '已完成'
  if (status === 'pending') return '待处理'
  return '空闲'
}

function overviewTags(agent: WorkspaceAgent) {
  const fromCapabilities = agent.capabilityTags
    .map((tag) => tag.replace(/^skill:/, ''))
    .filter(Boolean)
  const base = fromCapabilities.length
    ? fromCapabilities
    : [
        agent.runtimeType === 'code-agent' ? '写代码' : '对话协作',
        agent.contextPolicy === 'workspace-aware' ? '读项目' : '读上下文',
        agent.autoInvoke ? '自动协作' : '手动调用',
      ]
  return Array.from(new Set(base)).slice(0, 6)
}
