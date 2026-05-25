import { FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  FolderOpen,
  GitBranch,
  MessageSquare,
  PanelLeft,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  Wand2,
  X,
} from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import { loadAgentLibrary, toAgentConfigInput, type SavedAgentConfig } from '../lib/agentLibrary'
import { api, type AgentConfigInput, type ModelCatalogItem, type SkillSummary, type TaskStatus, type WorkspaceAgent, type WorkspaceTask } from '../lib/api'
import { pickWorkspaceFolder } from '../lib/native'
import { cn } from '../lib/utils'
import { useWorkspaceStore } from '../stores/workspaceStore'

const agentPresets = [
  { name: 'Architect', role: '规划', color: '#6366f1', systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。' },
  { name: 'Coder', role: '实现', color: '#10b981', systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文，再小步迭代。' },
  { name: 'Researcher', role: '研究', color: '#f59e0b', systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点。给出参考来源。' },
  { name: 'Reviewer', role: '审查', color: '#ef4444', systemPrompt: '你是审查者。检查风险、交互漏洞和缺失的测试。直接、克制、不绕弯。' },
]

const defaultAgentDraft: AgentConfigInput = {
  name: '',
  role: '',
  description: '',
  systemPrompt: '',
  color: '#111827',
  modelId: null,
  runtimeType: 'llm',
  codeAgentType: null,
  capabilityTags: [],
  toolPermissions: ['chat'],
  sandboxPolicy: 'workspace-write',
  contextPolicy: 'workspace-aware',
  autoInvoke: true,
  approvalRequired: true,
}

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
    openGroupSession,
  } = useWorkspaceStore()
  const [newGoal, setNewGoal] = useState('')
  const [agentDialogMode, setAgentDialogMode] = useState<'create' | 'edit' | null>(null)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [agentDraft, setAgentDraft] = useState<AgentConfigInput>(freshAgentDraft())
  const [newTask, setNewTask] = useState({ title: '', description: '', agentId: '' })
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: '', goal: '', projectPath: '' })
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [libraryAgents, setLibraryAgents] = useState<SavedAgentConfig[]>([])
  const [savingGoal, setSavingGoal] = useState(false)
  const [savingAgent, setSavingAgent] = useState(false)
  const [openingFolder, setOpeningFolder] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

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

  useEffect(() => {
    let cancelled = false
    api
      .getSettings()
      .then((settings) => {
        if (cancelled || !settings.MODEL_CATALOG) return
        const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelCatalogItem[]
        setModels(parsed.filter((item) => item.enabled))
      })
      .catch(() => setModels([]))
    api
      .listSkills()
      .then((result) => setSkills(result.items))
      .catch(() => setSkills([]))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setLibraryAgents(loadAgentLibrary())
    const sync = () => setLibraryAgents(loadAgentLibrary())
    window.addEventListener('agenthub:agent-library-change', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('agenthub:agent-library-change', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === currentId) ?? null,
    [currentId, workspaces]
  )
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const pendingCount = tasks.filter((task) => task.status === 'pending').length
  const runningCount = tasks.filter((task) => task.status === 'running').length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const failedCount = tasks.filter((task) => task.status === 'failed').length
  const dispatchedCount = tasks.filter((task) => Boolean(task.sessionId)).length

  useEffect(() => {
    if (!activeWorkspace) return
    setWorkspaceDraft({
      name: activeWorkspace.name,
      goal: activeWorkspace.goal,
      projectPath: activeWorkspace.projectPath ?? '',
    })
  }, [activeWorkspace?.id])

  async function openProjectFolder() {
    if (openingFolder) return
    const goal = newGoal.trim()
    setOpeningFolder(true)
    toast('正在打开文件夹选择器...')
    try {
      const nativePath = await pickWorkspaceFolder().catch(() => null)
      const result = await api.openWorkspaceFolder(nativePath)
      if (result.cancelled || !result.projectPath) {
        toast('已取消选择文件夹')
        return
      }
      const workspace =
        result.workspace ??
        (
          await createWorkspace({
            name: workspaceNameFromPath(result.projectPath) || '项目文件夹',
            goal,
            projectPath: result.projectPath,
            template: 'classic',
          })
        )
      await fetchList()
      await selectWorkspace(workspace.id)
      if (!result.workspace && goal) {
        const seededAgents = useWorkspaceStore.getState().agents
        for (const agent of seededAgents) {
          await addTask({
            title: starterTaskTitle(agent.role),
            description: `围绕协作目标：${goal}\n请以 ${agent.role} 视角输出可执行结果，并列出需要其他 Agent 配合的信息。`,
            agentId: agent.id,
          })
        }
      }
      setNewGoal('')
      toast('已打开项目文件夹')
    } catch (err) {
      toast(errorMessage(err, '项目文件夹打开失败'))
    } finally {
      setOpeningFolder(false)
    }
  }

  async function saveGoal() {
    if (!activeWorkspace) return
    setSavingGoal(true)
    try {
      await updateWorkspace(activeWorkspace.id, {
        name: workspaceDraft.name.trim() || activeWorkspace.name,
        goal: workspaceDraft.goal,
        projectPath: workspaceDraft.projectPath.trim() || null,
      })
      toast('项目文件夹已保存')
    } catch (err) {
      toast(errorMessage(err, '保存失败'))
    } finally {
      setSavingGoal(false)
    }
  }

  function openCreateAgent(preset: Partial<AgentConfigInput> = {}) {
    setAgentDraft(freshAgentDraft(preset))
    setEditingAgentId(null)
    setAgentDialogMode('create')
  }

  function openEditAgent(agent: WorkspaceAgent) {
    setAgentDraft(agentToDraft(agent))
    setEditingAgentId(agent.id)
    setAgentDialogMode('edit')
  }

  function closeAgentDialog() {
    if (savingAgent) return
    setAgentDialogMode(null)
    setEditingAgentId(null)
    setAgentDraft(freshAgentDraft())
  }

  async function saveAgentFromDialog(event: FormEvent) {
    event.preventDefault()
    const payload = normalizeAgentDraft(agentDraft)
    if (!payload.name || !payload.role) return

    setSavingAgent(true)
    try {
      if (agentDialogMode === 'edit' && editingAgentId) {
        await updateAgent(editingAgentId, payload)
        toast('Agent 设置已保存')
      } else {
        await addAgent(payload)
        toast('已添加 Agent')
      }
      setAgentDialogMode(null)
      setEditingAgentId(null)
      setAgentDraft(freshAgentDraft())
    } catch (err) {
      toast(errorMessage(err, '保存 Agent 失败'))
    } finally {
      setSavingAgent(false)
    }
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

  async function enterGroupChat() {
    const sessionId = await openGroupSession()
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
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <PanelLeft className={cn('h-4 w-4 transition-transform duration-300', sidebarCollapsed && 'rotate-180')} />
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
            <button
              type="button"
              onClick={enterGroupChat}
              disabled={!currentId}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:text-neutral-300"
            >
              <MessageSquare className="h-4 w-4" />
              进入群聊
            </button>
            <button
              type="button"
              onClick={() => navigate('/skills')}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
            >
              <Wand2 className="h-4 w-4" />
              Skills 广场
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-80 shrink-0 border-r border-neutral-200 bg-[#fbfbf9] p-4">
            <div className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
              <label className="text-xs text-neutral-500">打开项目文件夹</label>
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-neutral-200 px-3">
                <FolderOpen className="h-4 w-4 shrink-0 text-neutral-400" />
                <div className="flex h-10 min-w-0 flex-1 items-center truncate text-sm text-neutral-500">
                  {activeWorkspace?.projectPath || '选择本地项目文件夹'}
                </div>
              </div>
              <textarea
                value={newGoal}
                onChange={(event) => setNewGoal(event.target.value)}
                className="mt-3 h-20 w-full resize-none rounded-xl border border-neutral-200 bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-neutral-300"
                placeholder="协作目标，可选"
              />
              <button
                type="button"
                onClick={openProjectFolder}
                disabled={openingFolder}
                className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200"
              >
                {openingFolder ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                {openingFolder ? '正在打开...' : '打开文件夹'}
              </button>
            </div>

            <div className="mt-5 text-xs text-neutral-400">已打开文件夹</div>
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
                    <FolderOpen className="h-4 w-4 shrink-0 text-neutral-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{workspace.name}</span>
                        <span className="block truncate text-xs text-neutral-400">
                          {workspace.projectPath || formatTime(workspace.updatedAt)}
                        </span>
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
                  暂无项目文件夹，先打开一个本地项目。
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
                    <label className="mt-2 flex max-w-3xl items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm text-neutral-600 shadow-sm">
                      <FolderOpen className="h-4 w-4 shrink-0 text-neutral-400" />
                      <input
                        value={workspaceDraft.projectPath}
                        onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, projectPath: event.target.value }))}
                        className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-neutral-300"
                        placeholder="项目文件夹路径，Agent 集群会在这里运行"
                      />
                    </label>
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
                  <Stat value={failedCount} label="失败" />
                  <Stat value={dispatchedCount} label="已开会话" />
                </div>

                <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
                  <div className="space-y-6">
                    <Panel
                      title="Agent 团队"
                      action={
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <PresetButtons
                            libraryAgents={libraryAgents}
                            onManage={() => navigate('/agent-config')}
                            onPick={(preset) => openCreateAgent(preset)}
                          />
                          <button
                            type="button"
                            onClick={() => openCreateAgent()}
                            className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
                          >
                            <Plus className="h-4 w-4" />
                            添加 Agent
                          </button>
                        </div>
                      }
                    >
                      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                        {agents.map((agent) => (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            models={models}
                            onEdit={() => openEditAgent(agent)}
                            onDelete={() => deleteAgent(agent.id)}
                          />
                        ))}
                        {!agents.length && (
                          <div className="rounded-2xl border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-400 md:col-span-2">
                            还没有 Agent。添加成员后即可为任务指定分工。
                          </div>
                        )}
                      </div>
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
                        <MiniStat value={failedCount} label="失败" />
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

      {agentDialogMode && (
        <AgentDialog
          mode={agentDialogMode}
          draft={agentDraft}
                models={models}
                skills={skills}
                libraryAgents={libraryAgents}
                saving={savingAgent}
          onChange={(patch) => setAgentDraft((draft) => ({ ...draft, ...patch }))}
          onClose={closeAgentDialog}
          onSubmit={saveAgentFromDialog}
        />
      )}

      {notice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          {notice}
        </div>
      )}
    </div>
  )
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  const last = normalized.split(/[\\/]/).filter(Boolean).pop()
  return last ?? ''
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
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

function splitList(value: string) {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function freshAgentDraft(overrides: Partial<AgentConfigInput> = {}): AgentConfigInput {
  return {
    ...defaultAgentDraft,
    ...overrides,
    capabilityTags: overrides.capabilityTags ? [...overrides.capabilityTags] : [...(defaultAgentDraft.capabilityTags ?? [])],
    toolPermissions: overrides.toolPermissions ? [...overrides.toolPermissions] : [...(defaultAgentDraft.toolPermissions ?? [])],
  }
}

function agentToDraft(agent: WorkspaceAgent): AgentConfigInput {
  return {
    name: agent.name,
    role: agent.role,
    description: agent.description,
    avatar: agent.avatar,
    systemPrompt: agent.systemPrompt,
    color: agent.color,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: [...agent.capabilityTags],
    toolPermissions: [...agent.toolPermissions],
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    autoInvoke: agent.autoInvoke,
    approvalRequired: agent.approvalRequired,
  }
}

function normalizeAgentDraft(draft: AgentConfigInput): AgentConfigInput {
  const runtimeType = draft.runtimeType ?? 'llm'
  const nativeReadOnly = runtimeType === 'mcp'
  const capabilityTags = draft.capabilityTags ?? []
  const hasSkillTags = capabilityTags.some((tag) => tag.startsWith('skill:'))
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    description: draft.description?.trim() ?? '',
    avatar: draft.avatar ?? null,
    systemPrompt: draft.systemPrompt?.trim() ?? '',
    color: draft.color ?? '#111827',
    modelId: draft.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
    capabilityTags,
    toolPermissions: nativeReadOnly
      ? ['workspace:read', 'skills:read']
      : hasSkillTags
        ? Array.from(new Set([...(draft.toolPermissions?.length ? draft.toolPermissions : ['chat']), 'skills:read']))
      : draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: nativeReadOnly ? 'read-only' : (draft.sandboxPolicy ?? 'workspace-write'),
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: nativeReadOnly ? true : (draft.approvalRequired ?? true),
  }
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

function PresetButtons({
  libraryAgents,
  onManage,
  onPick,
}: {
  libraryAgents: SavedAgentConfig[]
  onManage: () => void
  onPick: (preset: Partial<AgentConfigInput>) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <select
        value=""
        onChange={(event) => {
          const agent = libraryAgents.find((item) => item.id === event.target.value)
          if (agent) onPick(toAgentConfigInput(agent))
        }}
        className="h-9 rounded-xl border border-neutral-200 bg-white px-2.5 text-xs text-neutral-600 outline-none transition hover:bg-neutral-50"
      >
        <option value="">从配置库套用</option>
        {libraryAgents.map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.name} / {agent.role}</option>
        ))}
      </select>
      {agentPresets.slice(0, 2).map((preset) => (
        <button
          key={preset.name}
          type="button"
          onClick={() => onPick(preset)}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-2.5 text-xs text-neutral-500 transition hover:bg-neutral-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {preset.role}
        </button>
      ))}
      <button
        type="button"
        onClick={onManage}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-2.5 text-xs text-neutral-500 transition hover:bg-neutral-50"
      >
        <Settings2 className="h-3.5 w-3.5" />
        管理配置
      </button>
    </div>
  )
}

function AgentCard({
  agent,
  models,
  onEdit,
  onDelete,
}: {
  agent: WorkspaceAgent
  models: ModelCatalogItem[]
  onEdit: () => void
  onDelete: () => void
}) {
  const modelLabel = modelName(agent.modelId, models)
  const visibleTags = agent.capabilityTags.length ? agent.capabilityTags.slice(0, 3) : [runtimeLabel(agent.runtimeType)]

  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-3 transition hover:border-neutral-300 hover:shadow-sm">
      <div className="flex items-start gap-2.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white" style={{ background: agent.color }}>
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{agent.name}</div>
          <div className="mt-1 truncate text-xs text-neutral-500">{agent.role}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            title="设置 Agent"
            aria-label={`${agent.name} 设置`}
            className="grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="删除 Agent"
            aria-label={`删除 ${agent.name}`}
            className="grid h-7 w-7 place-items-center rounded-lg text-neutral-300 transition hover:bg-red-50 hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <p className="mt-3 max-h-10 overflow-hidden text-xs leading-5 text-neutral-600">
        {agent.description || '暂无能力说明'}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <AgentPill>{modelLabel}</AgentPill>
        <AgentPill>{agent.codeAgentType ? codeAgentLabel(agent.codeAgentType) : runtimeLabel(agent.runtimeType)}</AgentPill>
        <AgentPill>{sandboxLabel(agent.sandboxPolicy)}</AgentPill>
        {visibleTags.map((tag) => (
          <span key={tag} className="inline-flex h-6 items-center rounded-full bg-neutral-100 px-2 text-xs text-neutral-600">
            {tag}
          </span>
        ))}
        {agent.autoInvoke && (
          <span className="inline-flex h-6 items-center rounded-full bg-emerald-50 px-2 text-xs text-emerald-700">
            自动调用
          </span>
        )}
        {agent.approvalRequired && (
          <span className="inline-flex h-6 items-center rounded-full bg-amber-50 px-2 text-xs text-amber-700">
            风险确认
          </span>
        )}
      </div>
    </article>
  )
}

function AgentPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center truncate rounded-full border border-neutral-200 bg-white px-2 text-xs text-neutral-500">
      {children}
    </span>
  )
}

function AgentDialog({
  mode,
  draft,
  models,
  skills,
  libraryAgents,
  saving,
  onChange,
  onSubmit,
  onClose,
}: {
  mode: 'create' | 'edit'
  draft: AgentConfigInput
  models: ModelCatalogItem[]
  skills: SkillSummary[]
  libraryAgents: SavedAgentConfig[]
  saving: boolean
  onChange: (patch: Partial<AgentConfigInput>) => void
  onSubmit: (event: FormEvent) => void
  onClose: () => void
}) {
  const runtimeType = draft.runtimeType ?? 'llm'
  const selectClass = 'h-10 rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none transition focus:border-neutral-400 disabled:bg-neutral-50 disabled:text-neutral-300'

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-neutral-950/35 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-dialog-title"
      onMouseDown={onClose}
    >
      <form
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
        className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-neutral-100 bg-white px-5 py-4">
          <div>
            <h2 id="agent-dialog-title" className="text-base font-semibold">
              {mode === 'create' ? '添加 Agent' : 'Agent 设置'}
            </h2>
            <p className="mt-1 text-xs text-neutral-400">
              {mode === 'create' ? '创建一个新的协作成员' : '调整这个成员的运行方式'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 p-5 md:grid-cols-2">
          {libraryAgents.length > 0 && (
            <div className="md:col-span-2">
              <label className="text-sm">
                <span className="mb-2 block text-neutral-600">从全局配置库切换</span>
                <select
                  value=""
                  onChange={(event) => {
                    const agent = libraryAgents.find((item) => item.id === event.target.value)
                    if (agent) onChange(toAgentConfigInput(agent))
                  }}
                  className="h-10 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none transition focus:border-neutral-400"
                >
                  <option value="">选择一个已保存 Agent 配置</option>
                  {libraryAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name} / {agent.role}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <Field placeholder="名称，如 Designer" value={draft.name} onChange={(name) => onChange({ name })} />
          <Field placeholder="角色，如 设计" value={draft.role} onChange={(role) => onChange({ role })} />
          <textarea
            value={draft.description ?? ''}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder="能力说明，如 前端实现、接口联调、审查风险"
            className="h-20 resize-none rounded-xl border border-neutral-200 px-3 py-2 text-sm leading-6 outline-none placeholder:text-neutral-300 focus:border-neutral-400 md:col-span-2"
          />

          <select
            value={runtimeType}
            onChange={(event) => {
              const nextRuntime = event.target.value as WorkspaceAgent['runtimeType']
              onChange({
                runtimeType: nextRuntime,
                codeAgentType: nextRuntime === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
                ...(nextRuntime === 'mcp'
                  ? {
                      toolPermissions: ['workspace:read', 'skills:read'],
                      sandboxPolicy: 'read-only' as const,
                      approvalRequired: true,
                    }
                  : {}),
              })
            }}
            className={selectClass}
          >
            <option value="llm">普通 LLM Agent</option>
            <option value="code-agent">绑定 Coding Tools</option>
            <option value="mcp">Native Read-only Agent</option>
            <option value="a2a">A2A Agent</option>
          </select>
          <select
            value={runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : ''}
            onChange={(event) => onChange({ codeAgentType: (event.target.value || null) as WorkspaceAgent['codeAgentType'] })}
            disabled={runtimeType !== 'code-agent'}
            className={selectClass}
          >
            <option value="">不绑定 CLI</option>
            <option value="codex">Codex CLI</option>
            <option value="claude-code">Claude Code</option>
            <option value="opencode">OpenCode</option>
          </select>
          <select value={draft.modelId ?? ''} onChange={(event) => onChange({ modelId: event.target.value || null })} className={selectClass}>
            <option value="">自动模型</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.modelId}</option>)}
          </select>
          <select value={draft.sandboxPolicy ?? 'workspace-write'} onChange={(event) => onChange({ sandboxPolicy: event.target.value as WorkspaceAgent['sandboxPolicy'] })} className={selectClass}>
            <option value="read-only">只读权限</option>
            <option value="workspace-write">工作区写入</option>
            <option value="danger-full-access">完全访问</option>
          </select>
          <select value={draft.contextPolicy ?? 'workspace-aware'} onChange={(event) => onChange({ contextPolicy: event.target.value as WorkspaceAgent['contextPolicy'] })} className={selectClass}>
            <option value="recent-only">仅最近上下文</option>
            <option value="pinned-recent">固定与最近上下文</option>
            <option value="workspace-aware">工作区上下文</option>
          </select>
          <Field placeholder="颜色，如 #111827" value={draft.color ?? '#111827'} onChange={(color) => onChange({ color })} />
          <Field placeholder="能力标签，逗号分隔" value={(draft.capabilityTags ?? []).join(', ')} onChange={(value) => onChange({ capabilityTags: splitList(value) })} />
          <Field placeholder="工具权限，逗号分隔" value={(draft.toolPermissions ?? []).join(', ')} onChange={(value) => onChange({ toolPermissions: splitList(value) })} />
          <SkillPicker skills={skills} selected={draft.capabilityTags ?? []} onChange={(next) => onChange({ capabilityTags: next })} />
          <textarea
            value={draft.systemPrompt ?? ''}
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
            placeholder="系统提示词"
            className="h-24 resize-none rounded-xl border border-neutral-200 px-3 py-2 text-sm leading-6 outline-none placeholder:text-neutral-300 focus:border-neutral-400 md:col-span-2"
          />

          <label className="flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600">
            <input type="checkbox" checked={draft.autoInvoke ?? true} onChange={(event) => onChange({ autoInvoke: event.target.checked })} />
            允许 Orchestrator 自动调用
          </label>
          <label className="flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600">
            <input type="checkbox" checked={draft.approvalRequired ?? true} onChange={(event) => onChange({ approvalRequired: event.target.checked })} />
            高风险操作需要确认
          </label>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-neutral-100 bg-white px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-neutral-200 px-4 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving || !draft.name.trim() || !draft.role.trim()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-200"
          >
            {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
            {mode === 'create' ? '添加 Agent' : '保存设置'}
          </button>
        </div>
      </form>
    </div>
  )
}

function SkillPicker({
  skills,
  selected,
  onChange,
}: {
  skills: SkillSummary[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const selectedIds = new Set(selected.filter((tag) => tag.startsWith('skill:')).map((tag) => tag.slice(6)))

  function toggle(skillId: string) {
    const next = new Set(selected)
    const tag = `skill:${skillId}`
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    onChange(Array.from(next))
  }

  return (
    <div className="md:col-span-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-neutral-700">Skills</span>
        <span className="text-xs text-neutral-400">{selectedIds.size} 已绑定</span>
      </div>
      <div className="max-h-48 overflow-auto rounded-xl border border-neutral-200 bg-white p-2">
        {skills.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {skills.map((skill) => {
              const active = selectedIds.has(skill.id)
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggle(skill.id)}
                  className={cn(
                    'rounded-lg border p-3 text-left transition',
                    active ? 'border-emerald-300 bg-emerald-50' : 'border-neutral-200 bg-white hover:border-neutral-300'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium text-neutral-900">{skill.name}</div>
                    {active && <Check className="h-4 w-4 text-emerald-600" />}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{skill.description || skill.id}</div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="px-3 py-8 text-center text-sm text-neutral-400">暂无可用 skills</div>
        )}
      </div>
      <div className="mt-2 text-xs text-neutral-400">绑定后会写入 `skill:xxx` 标签，并自动参与上下文注入。</div>
    </div>
  )
}

function modelName(modelId: string | null, models: ModelCatalogItem[]) {
  if (!modelId) return '自动模型'
  const model = models.find((item) => item.id === modelId || item.modelId === modelId)
  return model?.name || model?.modelId || modelId
}

function runtimeLabel(value: WorkspaceAgent['runtimeType']) {
  const map: Record<WorkspaceAgent['runtimeType'], string> = {
    llm: 'LLM Agent',
    'code-agent': 'Coding Tools',
    mcp: 'Native Read-only',
    a2a: 'A2A Agent',
  }
  return map[value]
}

function codeAgentLabel(value: NonNullable<WorkspaceAgent['codeAgentType']>) {
  const map: Record<NonNullable<WorkspaceAgent['codeAgentType']>, string> = {
    codex: 'Codex CLI',
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
  }
  return map[value]
}

function sandboxLabel(value: WorkspaceAgent['sandboxPolicy']) {
  const map: Record<WorkspaceAgent['sandboxPolicy'], string> = {
    'read-only': '只读',
    'workspace-write': '工作区写入',
    'danger-full-access': '完全访问',
  }
  return map[value]
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
            {task.status === 'failed' ? '重试' : task.sessionId ? '重新分派' : '分派'}
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
  if (status === 'done') return 'failed'
  return 'pending'
}

function statusLabel(status: TaskStatus) {
  if (status === 'pending') return '待分派'
  if (status === 'running') return '进行中'
  if (status === 'failed') return '失败'
  return '已完成'
}

function statusDot(status: TaskStatus) {
  if (status === 'pending') return 'bg-neutral-300'
  if (status === 'running') return 'bg-blue-500'
  if (status === 'failed') return 'bg-red-500'
  return 'bg-emerald-500'
}
