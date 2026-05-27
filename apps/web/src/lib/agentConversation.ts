import { api, type Session } from './api'
import { loadAgentLibraryState, toAgentConfigInput, type SavedAgentConfig } from './agentLibrary'

export interface StartAgentConversationOptions {
  agents: SavedAgentConfig[]
  title?: string
}

export async function startAgentConversation({
  agents,
  title,
}: StartAgentConversationOptions): Promise<Session> {
  if (!agents.length) throw new Error('请选择至少一个 Agent')

  const workspaceTitle = (title?.trim() || defaultConversationTitle(agents)).slice(0, 80)
  const full = await api.createWorkspace({
    name: workspaceTitle,
    goal: agents.length === 1 ? `与 ${agents[0]!.name} 单聊` : `邀请 ${agents.length} 个 Agent 组成群聊`,
    projectPath: null,
    template: 'blank',
  })

  const invitedAgents = []
  const savedToWorkspaceAgentId = new Map<string, string>()
  for (const agent of agents) {
    const workspaceAgent = await api.addWorkspaceAgent(full.workspace.id, toAgentConfigInput(agent))
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
      await api.replaceWorkspaceAgentRelations(full.workspace.id, copiedRelations)
    }
  }

  if (invitedAgents.length === 1) {
    const { session } = await api.openWorkspaceAgentSession(full.workspace.id, invitedAgents[0]!.id)
    return session
  }

  const { session } = await api.openWorkspaceGroupSession(full.workspace.id)
  return session
}

export function defaultConversationTitle(agents: SavedAgentConfig[]) {
  if (agents.length === 1) return agents[0]!.name
  const names = agents.slice(0, 3).map((agent) => agent.name).join('、')
  return agents.length > 3 ? `${names} 等 ${agents.length} 位 Agent` : names
}
