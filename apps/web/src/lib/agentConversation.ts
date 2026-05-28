import { api, type Session, type WorkspaceAgent, type WorkspaceFull } from './api'
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
  let preferredWorkspaceAgentId: string | null = null
  const dedicatedSingleAgent = !workspaceId && agents.length === 1

  if (workspaceId) {
    const full = await api.getWorkspace(workspaceId)
    workspace = full.workspace
    workspaceAgentsList = full.agents
  } else if (dedicatedSingleAgent) {
    const agent = agents[0]!
    const workspaceTitle = singleAgentWorkspaceName(agent)
    const existingWorkspace = await findWorkspaceForAgent(agent)
    if (existingWorkspace) {
      let full = await api.getWorkspace(existingWorkspace.workspaceId)
      workspace = full.workspace
      workspaceAgentsList = full.agents
      preferredWorkspaceAgentId = existingWorkspace.workspaceAgentId ?? null

      const patch: { name?: string; projectPath?: string | null } = {}
      if (workspace.name !== workspaceTitle) patch.name = workspaceTitle
      if (projectPath && !workspace.projectPath) patch.projectPath = projectPath
      if (Object.keys(patch).length) {
        full = await api.updateWorkspace(workspace.id, patch)
        workspace = full.workspace
        workspaceAgentsList = full.agents
      }
    } else {
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
    const existing = findReusableWorkspaceAgent(
      workspaceAgentsList,
      agent,
      dedicatedSingleAgent,
      dedicatedSingleAgent ? preferredWorkspaceAgentId : null,
    )
    if (existing) {
      const updated = await api.updateWorkspaceAgent(workspace.id, existing.id, toAgentConfigInput(agent))
      invitedAgents.push(updated)
      savedToWorkspaceAgentId.set(agent.id, updated.id)
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
    if (!dedicatedSingleAgent) return session

    const metadata = {
      ...(session.metadata ?? {}),
      kind: 'agent-direct',
      savedAgentId: agent.id,
    }
    if (
      session.title === agent.name &&
      session.metadata?.kind === 'agent-direct' &&
      session.metadata?.savedAgentId === agent.id
    ) {
      return session
    }

    return api.updateSession(session.id, {
      title: agent.name,
      workspaceId: workspace.id,
      workspaceAgentId: workspaceAgent.id,
      metadata,
    })
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
  const agentName = normalizeMatchText(agent.name)
  const agentRole = normalizeMatchText(agent.role)
  if (!agentName) return null

  let groupWorkspaceIds = new Set<string>()
  try {
    const { items: sessions } = await api.listSessions()
    groupWorkspaceIds = new Set(
      sessions
        .filter((session) => session.type === 'group' && session.workspaceId)
        .map((session) => session.workspaceId!),
    )

    const directBySavedId = sessions.find((session) => {
      const metadata = session.metadata ?? {}
      return (
        isDirectWorkspaceAgentSession(session) &&
        metadata.kind === 'agent-direct' &&
        metadata.savedAgentId === agent.id
      )
    })
    if (directBySavedId?.workspaceId) {
      return {
        workspaceId: directBySavedId.workspaceId,
        workspaceAgentId: directBySavedId.workspaceAgentId ?? null,
      }
    }

    const legacyDirect = sessions.find((session) => {
      if (!isDirectWorkspaceAgentSession(session)) return false
      if (groupWorkspaceIds.has(session.workspaceId!)) return false
      if (isGeneratedTaskMetadata(session.metadata)) return false
      return sessionLooksLikeAgentSession(session.title, agentName, agentRole)
    })
    if (legacyDirect?.workspaceId) {
      return {
        workspaceId: legacyDirect.workspaceId,
        workspaceAgentId: legacyDirect.workspaceAgentId ?? null,
      }
    }
  } catch {
    groupWorkspaceIds = new Set()
  }

  try {
    const { items } = await api.listWorkspaces()
    let fallback: { workspaceId: string; workspaceAgentId: string | null } | null = null
    for (const ws of items) {
      if (groupWorkspaceIds.has(ws.id)) continue

      const full = await api.getWorkspace(ws.id)
      const byName = full.agents.find((wa) => normalizeMatchText(wa.name) === agentName)
      if (normalizeMatchText(full.workspace.name) === agentName) {
        return {
          workspaceId: ws.id,
          workspaceAgentId: byName?.id ?? (full.agents.length === 1 ? full.agents[0]!.id : null),
        }
      }

      const byNameAndRole = full.agents.find(
        (wa) => normalizeMatchText(wa.name) === agentName && normalizeMatchText(wa.role) === agentRole,
      )
      if (!fallback && byNameAndRole) {
        fallback = { workspaceId: ws.id, workspaceAgentId: byNameAndRole.id }
      }
    }
    return fallback
  } catch {
    // 查询失败时降级为创建新工作区
  }
  return null
}

function singleAgentWorkspaceName(agent: SavedAgentConfig) {
  return (agent.name.trim() || 'Agent').slice(0, 80)
}

function findReusableWorkspaceAgent(
  workspaceAgentsList: WorkspaceAgent[],
  agent: SavedAgentConfig,
  dedicatedSingleAgent: boolean,
  preferredWorkspaceAgentId: string | null,
) {
  if (preferredWorkspaceAgentId) {
    const preferred = workspaceAgentsList.find((wa) => wa.id === preferredWorkspaceAgentId)
    if (preferred) return preferred
  }

  const agentName = normalizeMatchText(agent.name)
  if (dedicatedSingleAgent) {
    const byName = workspaceAgentsList.find((wa) => normalizeMatchText(wa.name) === agentName)
    if (byName) return byName
  }

  const agentRole = normalizeMatchText(agent.role)
  return (
    workspaceAgentsList.find(
      (wa) => normalizeMatchText(wa.name) === agentName && normalizeMatchText(wa.role) === agentRole,
    ) ?? null
  )
}

function isDirectWorkspaceAgentSession(session: Session) {
  return session.type === 'direct' && Boolean(session.workspaceId && session.workspaceAgentId)
}

function isGeneratedTaskMetadata(metadata: Record<string, unknown> | null | undefined) {
  return Boolean(
    metadata?.orchestratorTaskId ||
      metadata?.orchestratorRunId ||
      metadata?.hiddenFromSessionTree ||
      metadata?.kind === 'orchestrator-task',
  )
}

function sessionLooksLikeAgentSession(title: string, agentName: string, agentRole: string) {
  const normalizedTitle = normalizeMatchText(title)
  const titleParts = title.split('/').map((part) => normalizeMatchText(part))
  if (titleParts.some((part) => part === agentName)) return true
  return normalizedTitle.includes(agentName) && (!agentRole || normalizedTitle.includes(agentRole))
}

function normalizeMatchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
