import { FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Circle,
  GitBranch,
  Layers3,
  MessageSquare,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { type WorkspaceAgent, type WorkspaceTask, type TaskStatus } from '../lib/api'
import { cn } from '../lib/utils'
import { useWorkspaceStore } from '../stores/workspaceStore'

const agentPresets = [
  { name: 'Architect', role: '规划', color: '#6366f1', systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。' },
  { name: 'Coder', role: '实现', color: '#10b981', systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文，再小步迭代。' },
  { name: 'Researcher', role: '研究', color: '#f59e0b', systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点。给出参考来源。' },
  { name: 'Reviewer', role: '审查', color: '#ef4444', systemPrompt: '你是审查者。检查风险、交互漏洞和缺失的测试。直接、克制、不绕弯。' },
]

export default function AgentWorldPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    workspaces,
    currentId,
    agents,
    tasks,
    loadingList,
    loadingDetail,
    fetchList,
    createWorkspace,
    selectWorkspace,
    updateWorkspace,
    deleteWorkspace,
    addAgent,
    updateAgent,
    deleteAgent,
    addTask,
    updateTask,
    deleteTask,
    dispatchTask,
    summarize,
  } = useWorkspaceStore()
  const [newGoal, setNewGoal] = useState('把一个复杂任务拆给多个 Agent 并行推进')
  const [newAgent, setNewAgent] = useState({ name: '', role: '', systemPrompt: '', color: '#111827' })
  const [newTask, setNewTask] = useState({ title: '', description: '', agentId: '' })
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: '', goal: '' })
  const [savingGoal, setSavingGoal] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    fetchList().then(() => {
      const state = useWorkspaceStore.getState()
      const targetId =
        typeof location.state === 'object' &&
        location.state &&
        'workspaceId' in location.state &&
        typeof location.state.workspaceId === 'string'
          ? location.state.workspaceId
          : null
      if (targetId) {
        void state.selectWorkspace(targetId)
      } else if (!state.currentId && state.workspaces[0]) {
        void state.selectWorkspace(state.workspaces[0].id)
      }
    })
  }, [fetchList, location.state])

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === currentId) ?? null,
    [currentId, workspaces]
  )
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const pendingCount = tasks.filter((task) => task.status === 'pending').length
  const runningCount = tasks.filter((task) => task.status === 'running').length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const dispatchedCount = tasks.filter((task) => Boolean(task.sessionId)).length

  useEffect(() => {
    if (!activeWorkspace) return
    setWorkspaceDraft({ name: activeWorkspace.name, goal: activeWorkspace.goal })
  }, [activeWorkspace?.id])

  async function createClassicWorld(event: FormEvent) {
    event.preventDefault()
    const goal = newGoal.trim()
    if (!goal) return
    const workspace = await createWorkspace({ name: titleFromGoal(goal), goal, template: 'classic' })
    await selectWorkspace(workspace.id)
    const seededAgents = useWorkspaceStore.getState().agents
    for (const agent of seededAgents) {
      await addTask({
        title: starterTaskTitle(agent.role),
        description: `围绕协作目标：${goal}\n请以 ${agent.role} 视角输出可执行结果，并列出需要其他 Agent 配合的信息。`,
        agentId: agent.id,
      })
    }
    setNewGoal('')
    toast('已创建经典协作组')
  }

  async function saveGoal() {
    if (!activeWorkspace) return
    setSavingGoal(true)
    try {
      await updateWorkspace(activeWorkspace.id, {
        name: workspaceDraft.name.trim() || activeWorkspace.name,
        goal: workspaceDraft.goal,
      })
      toast('协作组已保存')
    } finally {
      setSavingGoal(false)
    }
  }

  async function addAgentFromForm(event: FormEvent) {
    event.preventDefault()
    if (!newAgent.name.trim() || !newAgent.role.trim()) return
    await addAgent({
      name: newAgent.name.trim(),
      role: newAgent.role.trim(),
      systemPrompt: newAgent.systemPrompt.trim(),
      color: newAgent.color,
    })
    setNewAgent({ name: '', role: '', systemPrompt: '', color: '#111827' })
    toast('已添加 Agent')
  }

  async function addTaskFromForm(event: FormEvent) {
    event.preventDefault()
    if (!newTask.title.trim()) return
    await addTask({
      title: newTask.title.trim(),
      description: newTask.description.trim(),
      agentId: newTask.agentId || null,
    })
    setNewTask({ title: '', description: '', agentId: '' })
    toast('已添加任务')
  }

  async function dispatch(task: WorkspaceTask, openAfterDispatch = true) {
    setBusyTaskId(task.id)
    try {
      const sessionId = await dispatchTask(task.id)
      if (sessionId && openAfterDispatch) navigate(`/chat/${sessionId}`)
      if (sessionId && !openAfterDispatch) toast('任务已分派')
    } finally {
      setBusyTaskId(null)
    }
  }

  async function dispatchAll() {
    const runnable = tasks.filter((task) => !task.sessionId)
    for (const task of runnable) {
      await dispatch(task, false)
    }
    if (!runnable.length) toast('所有任务都已分派')
  }

  async function openSummary() {
    const sessionId = await summarize()
    if (sessionId) navigate(`/chat/${sessionId}`)
  }

  function openTaskSession(task: WorkspaceTask) {
    if (task.sessionId) navigate(`/chat/${task.sessionId}`)
  }

  function toast(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 1600)
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
            <span className="truncate text-sm text-neutral-500">Agent Group</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fetchList()}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
            >
              <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
              刷新
            </button>
            <button
              type="button"
              onClick={openSummary}
              disabled={!currentId || !tasks.length}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200"
            >
              <GitBranch className="h-4 w-4" />
              群聊汇总
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-80 shrink-0 border-r border-neutral-200 bg-[#fbfbf9] p-4">
            <form onSubmit={createClassicWorld} className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
              <label className="text-xs text-neutral-500">新协作目标</label>
              <textarea
                value={newGoal}
                onChange={(event) => setNewGoal(event.target.value)}
                className="mt-2 h-24 w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-neutral-300"
                placeholder="输入一个需要多个 Agent 同时推进的任务"
              />
              <button type="submit" className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800">
                <Plus className="h-4 w-4" />
                新建协作组
              </button>
            </form>

            <div className="mt-5 text-xs text-neutral-400">协作组</div>
            <div className="mt-2 space-y-2">
              {workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-xl px-3 py-3 transition',
                    currentId === workspace.id ? 'bg-white shadow-sm' : 'hover:bg-white/70'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectWorkspace(workspace.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Layers3 className="h-4 w-4 shrink-0 text-neutral-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{workspace.name}</span>
                      <span className="block truncate text-xs text-neutral-400">{formatTime(workspace.updatedAt)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteWorkspace(workspace.id)}
                    className="grid h-7 w-7 place-items-center rounded-md text-neutral-300 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                    aria-label="删除协作组"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {!workspaces.length && (
                <div className="rounded-xl border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
                  暂无协作组，先创建一个经典团队。
                </div>
              )}
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto px-8 py-8">
            {activeWorkspace ? (
              <div className="mx-auto max-w-7xl">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="inline-flex h-7 items-center gap-2 rounded-full border border-neutral-200 px-3 text-xs text-neutral-500">
                      <Users className="h-3.5 w-3.5" />
                      多会话并行调度
                    </div>
                    <input
                      value={workspaceDraft.name}
                      onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, name: event.target.value }))}
                      className="mt-4 block w-full max-w-2xl bg-transparent text-3xl font-semibold tracking-normal outline-none"
                    />
                    <textarea
                      value={workspaceDraft.goal}
                      onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, goal: event.target.value }))}
                      className="mt-3 h-16 w-full max-w-3xl resize-none bg-transparent text-sm leading-7 text-neutral-500 outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveGoal}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
                    >
                      <Pencil className="h-4 w-4" />
                      {savingGoal ? '保存中' : '保存'}
                    </button>
                    <button
                      type="button"
                      onClick={dispatchAll}
                      disabled={!tasks.length}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200"
                    >
                      <Play className="h-4 w-4" />
                      一键分派
                    </button>
                  </div>
                </div>

                <div className="mt-8 grid gap-3 sm:grid-cols-4">
                  <Stat value={agents.length} label="Agent 成员" />
                  <Stat value={tasks.length} label="任务总数" />
                  <Stat value={runningCount} label="进行中" />
                  <Stat value={dispatchedCount} label="已开会话" />
                </div>

                <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
                  <div className="space-y-6">
                    <Panel title="Agent 团队" action={<PresetButtons onPick={(preset) => setNewAgent(preset)} />}>
                      <div className="grid gap-3 md:grid-cols-2">
                        {agents.map((agent) => (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            onChange={(patch) => updateAgent(agent.id, patch)}
                            onDelete={() => deleteAgent(agent.id)}
                          />
                        ))}
                      </div>
                      <form onSubmit={addAgentFromForm} className="mt-4 grid gap-3 rounded-2xl border border-dashed border-neutral-200 p-4 md:grid-cols-2">
                        <Field placeholder="名称，如 Designer" value={newAgent.name} onChange={(name) => setNewAgent((v) => ({ ...v, name }))} />
                        <Field placeholder="角色，如 设计" value={newAgent.role} onChange={(role) => setNewAgent((v) => ({ ...v, role }))} />
                        <Field className="md:col-span-2" placeholder="系统提示词" value={newAgent.systemPrompt} onChange={(systemPrompt) => setNewAgent((v) => ({ ...v, systemPrompt }))} />
                        <button type="submit" className="h-10 rounded-xl bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800 md:col-span-2">
                          添加 Agent
                        </button>
                      </form>
                    </Panel>

                    <Panel title="任务编排">
                      <form onSubmit={addTaskFromForm} className="grid gap-3 rounded-2xl border border-neutral-200 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
                        <Field placeholder="任务标题" value={newTask.title} onChange={(title) => setNewTask((v) => ({ ...v, title }))} />
                        <select
                          value={newTask.agentId}
                          onChange={(event) => setNewTask((v) => ({ ...v, agentId: event.target.value }))}
                          className="h-10 rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-neutral-400"
                        >
                          <option value="">未指定 Agent</option>
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>{agent.name} / {agent.role}</option>
                          ))}
                        </select>
                        <Field className="md:col-span-2" placeholder="任务说明，可写交付物、约束、依赖" value={newTask.description} onChange={(description) => setNewTask((v) => ({ ...v, description }))} />
                        <button type="submit" className="h-10 rounded-xl bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800 md:col-span-2">
                          添加任务
                        </button>
                      </form>

                      <div className="mt-4 space-y-3">
                        {tasks.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            agent={task.agentId ? agentMap.get(task.agentId) : undefined}
                            agents={agents}
                            busy={busyTaskId === task.id}
                            onPatch={(patch) => updateTask(task.id, patch)}
                            onDispatch={() => dispatch(task)}
                            onOpen={() => openTaskSession(task)}
                            onDelete={() => deleteTask(task.id)}
                          />
                        ))}
                        {!tasks.length && (
                          <div className="rounded-2xl border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-400">
                            还没有任务。添加任务后即可为每个 Agent 创建独立会话。
                          </div>
                        )}
                      </div>
                    </Panel>
                  </div>

                  <aside className="space-y-4">
                    <Panel title="群聊状态">
                      <div className="grid grid-cols-3 gap-2">
                        <MiniStat value={pendingCount} label="待分派" />
                        <MiniStat value={runningCount} label="推进中" />
                        <MiniStat value={doneCount} label="完成" />
                      </div>
                      <button
                        type="button"
                        onClick={openSummary}
                        disabled={!tasks.length}
                        className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
                      >
                        <MessageSquare className="h-4 w-4" />
                        汇总所有会话
                      </button>
                    </Panel>

                    <Panel title="会话入口">
                      <div className="space-y-2">
                        {tasks.filter((task) => task.sessionId).map((task) => {
                          const agent = task.agentId ? agentMap.get(task.agentId) : undefined
                          return (
                            <button
                              key={task.id}
                              type="button"
                              onClick={() => openTaskSession(task)}
                              className="flex w-full items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-3 text-left text-sm transition hover:bg-neutral-50"
                            >
                              <span className="min-w-0">
                                <span className="block truncate font-medium">{task.title}</span>
                                <span className="block truncate text-xs text-neutral-400">{agent ? `${agent.name} / ${agent.role}` : '未指定 Agent'}</span>
                              </span>
                              <ArrowRight className="h-4 w-4 shrink-0 text-neutral-400" />
                            </button>
                          )
                        })}
                        {!tasks.some((task) => task.sessionId) && (
                          <div className="rounded-xl border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
                            分派任务后，这里会出现每个 Agent 的独立会话入口。
                          </div>
                        )}
                      </div>
                    </Panel>

                    <Panel title="协作规则">
                      <div className="space-y-3 text-xs leading-5 text-neutral-500">
                        <Rule title="并行" text="每个任务会创建一个独立聊天会话，方便多个 Agent 同时推进。" />
                        <Rule title="汇总" text="群聊汇总会读取已分派任务的最新 Agent 输出，生成统一行动方案。" />
                        <Rule title="可追踪" text="任务状态、会话入口、Agent 分工都保存在工作区中。" />
                      </div>
                    </Panel>
                  </aside>
                </div>
              </div>
            ) : (
              <div className="grid h-full place-items-center text-sm text-neutral-400">
                {loadingDetail ? '正在加载协作组' : '创建一个协作组后开始多会话并行管理'}
              </div>
            )}
          </section>
        </div>
      </main>

      {notice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          {notice}
        </div>
      )}
    </div>
  )
}

function titleFromGoal(goal: string) {
  return goal.length > 16 ? `${goal.slice(0, 16)}...` : goal
}

function starterTaskTitle(role: string) {
  const map: Record<string, string> = {
    规划: '拆解目标与协作路径',
    实现: '实现核心功能并给出验证',
    研究: '补充方案调研与风险信息',
    审查: '审查风险、缺口与测试建议',
  }
  return map[role] ?? `${role} 分工任务`
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function MiniStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl bg-neutral-50 px-3 py-3">
      <div className="text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function PresetButtons({ onPick }: { onPick: (preset: { name: string; role: string; systemPrompt: string; color: string }) => void }) {
  return (
    <div className="flex gap-2">
      {agentPresets.slice(0, 2).map((preset) => (
        <button
          key={preset.name}
          type="button"
          onClick={() => onPick(preset)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 px-2 text-xs text-neutral-500 hover:bg-neutral-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {preset.role}
        </button>
      ))}
    </div>
  )
}

function AgentCard({
  agent,
  onChange,
  onDelete,
}: {
  agent: WorkspaceAgent
  onChange: (patch: Partial<{ name: string; role: string; systemPrompt: string; color: string }>) => void
  onDelete: () => void
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white" style={{ background: agent.color }}>
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={agent.name}
            onChange={(event) => onChange({ name: event.target.value })}
            className="w-full bg-transparent text-sm font-semibold outline-none"
          />
          <input
            value={agent.role}
            onChange={(event) => onChange({ role: event.target.value })}
            className="mt-1 w-full bg-transparent text-xs text-neutral-500 outline-none"
          />
        </div>
        <button type="button" onClick={onDelete} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-300 hover:bg-red-50 hover:text-red-500">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <textarea
        value={agent.systemPrompt}
        onChange={(event) => onChange({ systemPrompt: event.target.value })}
        className="mt-3 h-16 w-full resize-none bg-transparent text-xs leading-5 text-neutral-500 outline-none"
      />
    </div>
  )
}

function TaskRow({
  task,
  agent,
  agents,
  busy,
  onPatch,
  onDispatch,
  onOpen,
  onDelete,
}: {
  task: WorkspaceTask
  agent?: WorkspaceAgent
  agents: WorkspaceAgent[]
  busy: boolean
  onPatch: (patch: Partial<{ title: string; description: string; agentId: string | null; status: TaskStatus }>) => void
  onDispatch: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <button
          type="button"
          onClick={() => onPatch({ status: nextStatus(task.status) })}
          className="mt-1 text-neutral-400 hover:text-neutral-900"
          aria-label="切换任务状态"
        >
          {task.status === 'done' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Circle className="h-5 w-5" />}
        </button>
        <div className="min-w-0 flex-1">
          <input
            value={task.title}
            onChange={(event) => onPatch({ title: event.target.value })}
            className="w-full bg-transparent text-sm font-semibold outline-none"
          />
          <textarea
            value={task.description}
            onChange={(event) => onPatch({ description: event.target.value })}
            className="mt-1 h-12 w-full resize-none bg-transparent text-xs leading-5 text-neutral-500 outline-none"
            placeholder="任务说明"
          />
        </div>
        <select
          value={task.agentId ?? ''}
          onChange={(event) => onPatch({ agentId: event.target.value || null })}
          className="h-9 rounded-xl border border-neutral-200 bg-white px-3 text-xs outline-none focus:border-neutral-400"
        >
          <option value="">未指定</option>
          {agents.map((item) => (
            <option key={item.id} value={item.id}>{item.name} / {item.role}</option>
          ))}
        </select>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={cn('h-2 w-2 rounded-full', statusDot(task.status))} />
          {statusLabel(task.status)}
          <span>·</span>
          <span>{agent ? `${agent.name} / ${agent.role}` : '未指定 Agent'}</span>
        </div>
        <div className="flex items-center gap-2">
          {task.sessionId && (
            <button type="button" onClick={onOpen} className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm hover:bg-neutral-50">
              <MessageSquare className="h-4 w-4" />
              打开会话
            </button>
          )}
          <button
            type="button"
            onClick={onDispatch}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
          >
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {task.sessionId ? '重新进入' : '分派'}
          </button>
          <button type="button" onClick={onDelete} className="grid h-9 w-9 place-items-center rounded-xl text-neutral-300 hover:bg-red-50 hover:text-red-500">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={cn('h-10 rounded-xl border border-neutral-200 px-3 text-sm outline-none placeholder:text-neutral-300 focus:border-neutral-400', className)}
    />
  )
}

function Rule({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl bg-neutral-50 p-3">
      <div className="font-semibold text-neutral-800">{title}</div>
      <div className="mt-1">{text}</div>
    </div>
  )
}

function nextStatus(status: TaskStatus): TaskStatus {
  if (status === 'pending') return 'running'
  if (status === 'running') return 'done'
  return 'pending'
}

function statusLabel(status: TaskStatus) {
  if (status === 'pending') return '待分派'
  if (status === 'running') return '进行中'
  return '已完成'
}

function statusDot(status: TaskStatus) {
  if (status === 'pending') return 'bg-neutral-300'
  if (status === 'running') return 'bg-blue-500'
  return 'bg-emerald-500'
}
