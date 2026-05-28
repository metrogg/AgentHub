import type { Workspace } from './api'

export function isProjectWorkspace(workspace: Workspace) {
  if (workspace.projectPath?.trim()) return true

  const goal = workspace.goal.trim()
  if (!goal) return true

  return !/^与 .+ 单聊$/.test(goal) && !/^邀请 \d+ 个 Agent 组成群聊$/.test(goal)
}

export function workspaceSearchText(workspace: Workspace) {
  return `${workspace.name} ${workspace.goal} ${workspace.projectPath ?? ''}`.toLowerCase()
}

export function workspaceSubtitle(workspace: Workspace) {
  return workspace.projectPath?.trim() || '独立项目'
}
