import { create } from 'zustand'
import {
  api,
  type Workspace,
  type WorkspaceAgent,
  type WorkspaceFull,
  type WorkspaceTask,
  type TaskStatus,
  type AgentConfigInput,
} from '../lib/api'

interface WorkspaceState {
  workspaces: Workspace[]
  currentId: string | null
  agents: WorkspaceAgent[]
  tasks: WorkspaceTask[]
  loadingList: boolean
  loadingDetail: boolean

  // List ops
  fetchList: () => Promise<void>
  createWorkspace: (data: { name: string; goal?: string; projectPath?: string | null }) => Promise<Workspace>
  selectWorkspace: (id: string | null) => Promise<void>
  updateWorkspace: (id: string, data: { name?: string; goal?: string; projectPath?: string | null }) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>

  // Agent ops
  addAgent: (data: AgentConfigInput) => Promise<void>
  updateAgent: (
    agentId: string,
    data: Partial<AgentConfigInput>
  ) => Promise<void>
  deleteAgent: (agentId: string) => Promise<void>

  // Task ops
  addTask: (data: { title: string; description?: string; agentId?: string | null }) => Promise<void>
  updateTask: (
    taskId: string,
    data: Partial<{ title: string; description: string; agentId: string | null; status: TaskStatus }>
  ) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  openGroupSession: () => Promise<string | null>
}

function applyFull(full: WorkspaceFull) {
  return {
    currentId: full.workspace.id,
    agents: full.agents,
    tasks: full.tasks,
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  currentId: null,
  agents: [],
  tasks: [],
  loadingList: false,
  loadingDetail: false,

  async fetchList() {
    set({ loadingList: true })
    try {
      const { items } = await api.listWorkspaces()
      set({ workspaces: items, loadingList: false })
    } catch {
      set({ loadingList: false })
    }
  },

  async createWorkspace(data) {
    const full = await api.createWorkspace(data)
    set((s) => ({
      workspaces: [full.workspace, ...s.workspaces],
      ...applyFull(full),
    }))
    return full.workspace
  },

  async selectWorkspace(id) {
    if (!id) {
      set({ currentId: null, agents: [], tasks: [] })
      return
    }
    set({ loadingDetail: true })
    try {
      const full = await api.getWorkspace(id)
      set({ ...applyFull(full), loadingDetail: false })
    } catch {
      set({ loadingDetail: false, currentId: null, agents: [], tasks: [] })
    }
  },

  async updateWorkspace(id, data) {
    const full = await api.updateWorkspace(id, data)
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? full.workspace : w)),
      ...applyFull(full),
    }))
  },

  async deleteWorkspace(id) {
    await api.deleteWorkspace(id)
    set((s) => {
      const remaining = s.workspaces.filter((w) => w.id !== id)
      const isCurrent = s.currentId === id
      return {
        workspaces: remaining,
        currentId: isCurrent ? null : s.currentId,
        agents: isCurrent ? [] : s.agents,
        tasks: isCurrent ? [] : s.tasks,
      }
    })
  },

  async addAgent(data) {
    const id = get().currentId
    if (!id) return
    const agent = await api.addWorkspaceAgent(id, data)
    set((s) => ({ agents: [...s.agents, agent] }))
  },

  async updateAgent(agentId, data) {
    const id = get().currentId
    if (!id) return
    set((s) => ({ agents: s.agents.map((a) => (a.id === agentId ? { ...a, ...data } : a)) }))
    const agent = await api.updateWorkspaceAgent(id, agentId, data)
    set((s) => ({ agents: s.agents.map((a) => (a.id === agentId ? agent : a)) }))
  },

  async deleteAgent(agentId) {
    const id = get().currentId
    if (!id) return
    await api.deleteWorkspaceAgent(id, agentId)
    set((s) => ({
      agents: s.agents.filter((a) => a.id !== agentId),
      tasks: s.tasks.map((t) => (t.agentId === agentId ? { ...t, agentId: null } : t)),
    }))
  },

  async addTask(data) {
    const id = get().currentId
    if (!id) return
    const task = await api.addWorkspaceTask(id, data)
    set((s) => ({ tasks: [...s.tasks, task] }))
  },

  async updateTask(taskId, data) {
    const id = get().currentId
    if (!id) return
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...data } : t)) }))
    const task = await api.updateWorkspaceTask(id, taskId, data)
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? task : t)) }))
  },

  async deleteTask(taskId) {
    const id = get().currentId
    if (!id) return
    await api.deleteWorkspaceTask(id, taskId)
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) }))
  },

  async openGroupSession() {
    const id = get().currentId
    if (!id) return null
    const agentIds = get().agents.map((a) => a.id)
    const { session } = await api.openWorkspaceGroupSession(id, agentIds)
    return session.id
  },
}))
