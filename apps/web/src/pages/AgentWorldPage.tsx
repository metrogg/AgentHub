import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  Code2,
  GitBranch,
  Layers3,
  MessageSquare,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { cn } from '../lib/utils'
import { useChatStore } from '../stores/chatStore'

type LaneStatus = '待启动' | '进行中' | '已完成'

interface AgentLane {
  id: string
  role: string
  agent: string
  brief: string
  sessionId?: string
  status: LaneStatus
}

interface WorldRoom {
  id: string
  name: string
  goal: string
  createdAt: string
  lanes: AgentLane[]
}

const storageKey = 'agenthub.agentWorld'

const laneTemplates: Omit<AgentLane, 'id' | 'sessionId' | 'status'>[] = [
  {
    role: '规划',
    agent: 'Architect',
    brief: '拆解目标、定义边界、给出里程碑',
  },
  {
    role: '实现',
    agent: 'Coder',
    brief: '负责代码实现、组件接入和小步验证',
  },
  {
    role: '研究',
    agent: 'Researcher',
    brief: '补充资料、比较方案、标记不确定点',
  },
  {
    role: '审查',
    agent: 'Reviewer',
    brief: '检查风险、交互漏洞和缺失测试',
  },
]

export default function AgentWorldPage() {
  const navigate = useNavigate()
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const sendMessageToSession = useChatStore((state) => state.sendMessageToSession)
  const [rooms, setRooms] = useState<WorldRoom[]>([])
  const [activeRoomId, setActiveRoomId] = useState<string>('')
  const [newGoal, setNewGoal] = useState('把一个复杂任务拆给多个 Agent 并行推进')

  useEffect(() => {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as WorldRoom[]
        setRooms(parsed)
        setActiveRoomId(parsed[0]?.id ?? '')
        return
      } catch {
        // Keep the default room if local data is broken.
      }
    }
    const initial = [createRoom('Agent World 协作组', '把一个复杂任务拆给多个 Agent 并行推进')]
    setRooms(initial)
    setActiveRoomId(initial[0].id)
  }, [])

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) ?? rooms[0],
    [activeRoomId, rooms]
  )
  const runningCount = activeRoom?.lanes.filter((lane) => lane.status === '进行中').length ?? 0
  const linkedCount = activeRoom?.lanes.filter((lane) => lane.sessionId).length ?? 0

  function persist(next: WorldRoom[]) {
    setRooms(next)
    localStorage.setItem(storageKey, JSON.stringify(next))
  }

  function addRoom(event: FormEvent) {
    event.preventDefault()
    const goal = newGoal.trim()
    if (!goal) return
    const room = createRoom(titleFromGoal(goal), goal)
    persist([room, ...rooms])
    setActiveRoomId(room.id)
    setNewGoal('')
  }

  async function startLane(laneId: string) {
    if (!activeRoom) return
    const lane = activeRoom.lanes.find((item) => item.id === laneId)
    if (!lane) return

    if (lane.sessionId) {
      await selectSession(lane.sessionId)
      navigate(`/chat/${lane.sessionId}`)
      return
    }

    const session = await createSession(`${activeRoom.name} · ${lane.role}`)
    const prompt = [
      `你是 ${lane.agent}，正在参与 Agent World 多会话协作。`,
      `总目标：${activeRoom.goal}`,
      `你的分工：${lane.brief}`,
      '请先给出你的独立工作计划，然后开始推进，并在结尾列出需要其他 Agent 配合的信息。',
    ].join('\n')
    await sendMessageToSession(session.id, prompt)

    const next = rooms.map((room) =>
      room.id === activeRoom.id
        ? {
            ...room,
            lanes: room.lanes.map((item) =>
              item.id === laneId ? { ...item, sessionId: session.id, status: '进行中' as LaneStatus } : item
            ),
          }
        : room
    )
    persist(next)
    await selectSession(session.id)
    navigate(`/chat/${session.id}`)
  }

  async function startAll() {
    if (!activeRoom) return
    for (const lane of activeRoom.lanes) {
      if (!lane.sessionId) {
        await startLane(lane.id)
        break
      }
    }
  }

  async function createSummarySession() {
    if (!activeRoom) return
    const session = await createSession(`${activeRoom.name} · 群聊汇总`)
    const laneLines = activeRoom.lanes
      .map((lane) => `- ${lane.agent}/${lane.role}: ${lane.sessionId ? `会话 ${lane.sessionId}` : '尚未启动'}`)
      .join('\n')
    await sendMessageToSession(
      session.id,
      `请作为协调者汇总 Agent World 协作组。\n总目标：${activeRoom.goal}\n当前并行会话：\n${laneLines}\n请输出统一行动计划、风险和下一步分派。`
    )
    await selectSession(session.id)
    navigate(`/chat/${session.id}`)
  }

  function deleteRoom(roomId: string) {
    const next = rooms.filter((room) => room.id !== roomId)
    persist(next)
    if (activeRoomId === roomId) setActiveRoomId(next[0]?.id ?? '')
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
            <span className="truncate text-sm text-neutral-500">Agent World</span>
          </div>
          <button
            type="button"
            onClick={createSummarySession}
            disabled={!activeRoom}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200"
          >
            <GitBranch className="h-4 w-4" />
            群聊汇总
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 border-r border-neutral-200 bg-[#fbfbf9] p-4">
            <form onSubmit={addRoom} className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
              <label className="text-xs text-neutral-500">新协作目标</label>
              <textarea
                value={newGoal}
                onChange={(event) => setNewGoal(event.target.value)}
                className="mt-2 h-20 w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-neutral-300"
                placeholder="输入一个需要多个 Agent 同时推进的任务"
              />
              <button type="submit" className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800">
                <Plus className="h-4 w-4" />
                新建协作组
              </button>
            </form>

            <div className="mt-5 text-xs text-neutral-400">协作组</div>
            <div className="mt-2 space-y-2">
              {rooms.map((room) => (
                <div
                  key={room.id}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-xl px-3 py-3 transition',
                    activeRoom?.id === room.id ? 'bg-white shadow-sm' : 'hover:bg-white/70'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setActiveRoomId(room.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Layers3 className="h-4 w-4 shrink-0 text-neutral-500" />
                    <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{room.name}</span>
                    <span className="block truncate text-xs text-neutral-400">{room.lanes.length} 个并行会话</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      deleteRoom(room.id)
                    }}
                    className="grid h-7 w-7 place-items-center rounded-md text-neutral-300 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                    aria-label="删除协作组"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto px-8 py-8">
            {activeRoom ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="inline-flex h-7 items-center gap-2 rounded-full border border-neutral-200 px-3 text-xs text-neutral-500">
                      <Bot className="h-3.5 w-3.5" />
                      多会话并行管理
                    </div>
                    <h1 className="mt-4 text-3xl font-semibold tracking-normal">{activeRoom.name}</h1>
                    <p className="mt-3 max-w-2xl text-sm leading-7 text-neutral-500">{activeRoom.goal}</p>
                  </div>
                  <button
                    type="button"
                    onClick={startAll}
                    className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
                  >
                    <Play className="h-4 w-4" />
                    启动下一个会话
                  </button>
                </div>

                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  <Stat value={activeRoom.lanes.length} label="角色会话" />
                  <Stat value={linkedCount} label="已创建会话" />
                  <Stat value={runningCount} label="进行中" />
                </div>

                <div className="mt-8 grid gap-4 xl:grid-cols-2">
                  {activeRoom.lanes.map((lane) => (
                    <LanePanel key={lane.id} lane={lane} onStart={() => startLane(lane.id)} />
                  ))}
                </div>
              </>
            ) : (
              <div className="grid h-full place-items-center text-sm text-neutral-400">创建一个协作组后开始并行管理</div>
            )}
          </section>
        </div>
      </main>
    </div>
  )
}

function createRoom(name: string, goal: string): WorldRoom {
  return {
    id: crypto.randomUUID(),
    name,
    goal,
    createdAt: new Date().toISOString(),
    lanes: laneTemplates.map((template) => ({
      ...template,
      id: crypto.randomUUID(),
      status: '待启动',
    })),
  }
}

function titleFromGoal(goal: string) {
  return goal.length > 14 ? `${goal.slice(0, 14)}...` : goal
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function LanePanel({ lane, onStart }: { lane: AgentLane; onStart: () => void }) {
  const Icon = lane.role === '规划' ? Brain : lane.role === '实现' ? Code2 : lane.role === '研究' ? Search : CheckCircle2

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-neutral-100 text-neutral-700">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{lane.agent}</h3>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">{lane.role}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-neutral-500">{lane.brief}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between border-t border-neutral-100 pt-4">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={cn('h-2 w-2 rounded-full', lane.status === '进行中' ? 'bg-blue-500' : lane.status === '已完成' ? 'bg-emerald-500' : 'bg-neutral-300')} />
          {lane.status}
        </div>
        <button
          type="button"
          onClick={onStart}
          className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          {lane.sessionId ? (
            <>
              <MessageSquare className="h-4 w-4" />
              打开会话
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" />
              创建会话
            </>
          )}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
