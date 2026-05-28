import { api, type Session, type WorkspaceFull } from './api'
import { loadAgentLibraryState, toAgentConfigInput, type SavedAgentConfig } from './agentLibrary'

export interface StartAgentConversationOptions {
  agents: SavedAgentConfig[]
  title?: string
  workspaceId?: string | null
  projectPath?: string | null
}

export async function startAgentConversation({
  agents,
  title,
  workspaceId,
  projectPath,
}: StartAgentConversationOptions): Promise<Session> {
  if (!agents.length) throw new Error('请选择至少一个 Agent')

  let workspace: WorkspaceFull['workspace']
  let workspaceAgentsList: WorkspaceFull['agents']

  if (workspaceId) {
    const full = await api.getWorkspace(workspaceId)
    workspace = full.workspace
    workspaceAgentsList = full.agents
  } else if (agents.length === 1) {
    // 单 Agent 场景：尝试复用已有的工作区，避免重复创建
    const agent = agents[0]!
    const existingWorkspace = await findWorkspaceForAgent(agent)
    if (existingWorkspace) {
      const full = await api.getWorkspace(existingWorkspace.id)
      workspace = full.workspace
      workspaceAgentsList = full.agents
    } else {
      const workspaceTitle = (title?.trim() || defaultConversationTitle(agents)).slice(0, 80)
      const full = await api.createWorkspace({
        name: workspaceTitle,
        goal: `与 ${agent.name} 单聊`,
        projectPath: projectPath ?? null,
        template: 'blank',
      })
      workspace = full.workspace
      workspaceAgentsList = []
    }
  } else {
    const workspaceTitle = (title?.trim() || defaultConversationTitle(agents)).slice(0, 80)
    const full = await api.createWorkspace({
      name: workspaceTitle,
      goal: `邀请 ${agents.length} 个 Agent 组成群聊`,
      projectPath: projectPath ?? null,
      template: 'blank',
    })
    workspace = full.workspace
    workspaceAgentsList = []
  }

  const invitedAgents = []
  const savedToWorkspaceAgentId = new Map<string, string>()
  for (const agent of agents) {
    const existing = workspaceAgentsList.find((wa) => wa.name === agent.name && wa.role === agent.role)
    if (existing) {
      const updated = await api.updateWorkspaceAgent(workspace.id, existing.id, toAgentConfigInput(agent))
      invitedAgents.push(updated)
      savedToWorkspaceAgentId.set(agent.id, existing.id)
      workspaceAgentsList = workspaceAgentsList.map((item) => (item.id === existing.id ? updated : item))
      continue
    }
    const workspaceAgent = await api.addWorkspaceAgent(workspace.id, toAgentConfigInput(agent))
    invitedAgents.push(workspaceAgent)
    savedToWorkspaceAgentId.set(agent.id, workspaceAgent.id)
  }

  if (invitedAgents.length > 1) {
    const library = loadAgentLibraryState()
    const copiedRelations = library.relations.flatMap((relation) => {
      const sourceAgentId = savedToWorkspaceAgentId.get(relation.sourceAgentId)
      const targetAgentId = savedToWorkspaceAgentId.get(relation.targetAgentId)
      if (!sourceAgentId || !targetAgentId) return []
      return [{
        sourceAgentId,
        targetAgentId,
        relationType: relation.relationType,
        note: relation.note ?? null,
      }]
    })
    if (copiedRelations.length) {
      await api.replaceWorkspaceAgentRelations(workspace.id, copiedRelations)
    }
  }

  if (invitedAgents.length === 1) {
    const [agent] = agents
    const [workspaceAgent] = invitedAgents
    if (!agent || !workspaceAgent) throw new Error('Agent session create failed')
    // 优先复用已有的 agent 子会话（POST 接口会自动查找或创建）
    const { session } = await api.openWorkspaceAgentSession(workspace.id, workspaceAgent.id)
    return session
  }

  const agentIds = invitedAgents.map((a) => a.id)
  const { session } = await api.openWorkspaceGroupSession(workspace.id, agentIds)
  return session
}

export function defaultConversationTitle(agents: SavedAgentConfig[]) {
  if (agents.length === 1) return agents[0]!.name
  const names = agents.slice(0, 3).map((agent) => agent.name).join('、')
  return agents.length > 3 ? `${names} 等 ${agents.length} 位 Agent` : names
}

/**
 * 查找已包含指定 Agent 的工作区（按名称+角色匹配），避免重复创建。
 */
async function findWorkspaceForAgent(agent: SavedAgentConfig) {
  try {
    const { items } = await api.listWorkspaces()
    const agentName = agent.name.trim().toLowerCase()
    const agentRole = agent.role.trim().toLowerCase()
    for (const ws of items) {
      const full = await api.getWorkspace(ws.id)
      const matched = full.agents.some((wa) => {
        const waName = wa.name.trim().toLowerCase()
        const waRole = wa.role.trim().toLowerCase()
        return waName === agentName && waRole === agentRole
      })
      if (matched) return ws
    }
  } catch {
    // 查询失败时降级为创建新工作区
  }
  return null
}
