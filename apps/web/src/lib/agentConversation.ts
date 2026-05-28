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
  } else {
    const workspaceTitle = (title?.trim() || defaultConversationTitle(agents)).slice(0, 80)
    const full = await api.createWorkspace({
      name: workspaceTitle,
      goal: agents.length === 1 ? `与 ${agents[0]!.name} 单聊` : `邀请 ${agents.length} 个 Agent 组成群聊`,
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
    return api.createSession({
      title: agent.name,
      type: 'direct',
      workspaceId: workspace.id,
      workspaceAgentId: workspaceAgent.id,
      metadata: {
        kind: 'agent-direct',
        savedAgentId: agent.id,
      },
    })
  }

  const { session } = await api.openWorkspaceGroupSession(workspace.id)
  return session
}

export function defaultConversationTitle(agents: SavedAgentConfig[]) {
  if (agents.length === 1) return agents[0]!.name
  const names = agents.slice(0, 3).map((agent) => agent.name).join('、')
  return agents.length > 3 ? `${names} 等 ${agents.length} 位 Agent` : names
}
