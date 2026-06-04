import { request } from './apiClient'
import type {
  AgentConfigInput,
  Session,
  Workspace,
  WorkspaceActiveRun,
  WorkspaceAgent,
  WorkspaceAgentRelation,
  WorkspaceFileContentResponse,
  WorkspaceFileListResponse,
  WorkspaceFolderOpenResult,
  WorkspaceFull,
  WorkspaceTask,
} from './apiTypes'
import type { TaskStatus } from './apiTypes'

export const workspaceApi = {
  // Workspaces (group chats)
  listWorkspaces: () => request<{ items: Workspace[] }>('/workspaces'),
  createWorkspace: (data: {
    name: string
    goal?: string
    projectPath?: string | null
  }) => request<WorkspaceFull>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  createAutoWorkspace: (data: { name?: string; goal?: string }) =>
    request<WorkspaceFull>('/workspaces/auto', { method: 'POST', body: JSON.stringify(data) }),
  cloneGithubWorkspace: (data: { repoUrl: string; name?: string; goal?: string }) =>
    request<WorkspaceFull>('/workspaces/clone-github', {
      method: 'POST',
      timeout: 240_000,
      body: JSON.stringify(data),
    }),
  openWorkspaceFolder: (projectPath?: string | null) =>
    request<WorkspaceFolderOpenResult>('/workspaces/open-folder', {
      method: 'POST',
      timeout: 120_000,
      body: projectPath ? JSON.stringify({ projectPath }) : undefined,
    }),
  getWorkspace: (id: string) => request<WorkspaceFull>(`/workspaces/${id}`),
  getWorkspaceSessions: (id: string) => request<{ items: Session[] }>(`/workspaces/${id}/sessions`),
  getWorkspaceActiveRuns: (id: string) =>
    request<{ items: WorkspaceActiveRun[] }>(`/workspaces/${id}/active-runs`),
  listWorkspaceFiles: (id: string, path?: string | null) =>
    request<WorkspaceFileListResponse>(
      `/workspaces/${id}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  readWorkspaceFile: (id: string, path: string) =>
    request<WorkspaceFileContentResponse>(
      `/workspaces/${id}/files/content?path=${encodeURIComponent(path)}`,
    ),
  updateWorkspace: (
    id: string,
    data: { name?: string; goal?: string; projectPath?: string | null },
  ) => request<WorkspaceFull>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${id}`, { method: 'DELETE' }),

  addWorkspaceAgent: (id: string, data: AgentConfigInput) =>
    request<WorkspaceAgent>(`/workspaces/${id}/agents`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkspaceAgent: (id: string, agentId: string, data: Partial<AgentConfigInput>) =>
    request<WorkspaceAgent>(`/workspaces/${id}/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWorkspaceAgent: (id: string, agentId: string) =>
    request<void>(`/workspaces/${id}/agents/${agentId}`, { method: 'DELETE' }),
  getWorkspaceAgentRelations: (id: string) =>
    request<{ items: WorkspaceAgentRelation[] }>(`/workspaces/${id}/agent-relations`),
  replaceWorkspaceAgentRelations: (
    id: string,
    relations: Array<
      Pick<WorkspaceAgentRelation, 'sourceAgentId' | 'targetAgentId' | 'relationType'> & {
        note?: string | null
      }
    >,
  ) =>
    request<{ items: WorkspaceAgentRelation[] }>(`/workspaces/${id}/agent-relations`, {
      method: 'PUT',
      body: JSON.stringify({ relations }),
    }),

  addWorkspaceTask: (
    id: string,
    data: { title: string; description?: string; agentId?: string | null },
  ) =>
    request<WorkspaceTask>(`/workspaces/${id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkspaceTask: (
    id: string,
    taskId: string,
    data: Partial<{
      title: string
      description: string
      agentId: string | null
      status: TaskStatus
    }>,
  ) =>
    request<WorkspaceTask>(`/workspaces/${id}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWorkspaceTask: (id: string, taskId: string) =>
    request<void>(`/workspaces/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  openWorkspaceGroupSession: (id: string, agentIds?: string[]) =>
    request<{ session: Session }>(`/workspaces/${id}/group-session`, {
      method: 'POST',
      body: agentIds ? JSON.stringify({ agentIds }) : undefined,
    }),
}
