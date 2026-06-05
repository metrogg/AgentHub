import {
  existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  agents,
  db,
  eq,
  messages,
  sessionMembers,
  sessions,
  settings,
  tasks,
  workspaceAgents,
  workspaceTasks,
  workspaces,
} from '@agenthub/db'

type SessionRow = typeof sessions.$inferSelect
type WorkspaceTaskRow = typeof workspaceTasks.$inferSelect

export interface LegacyCleanupResult {
  success: true
  deletedSessions: number
  deletedMessages: number
  deletedSessionMembers: number
  deletedWorkspaceTasks: number
  deletedLegacyTasks: number
  deletedLegacyAgents: number
  deletedEmptyWorkspaces: number
  cleanedSettings: number
  deletedLegacySpecDirs: number
}

const agentLibrarySettingKey = 'AGENT_LIBRARY'

export async function cleanupLegacyApplicationData(): Promise<LegacyCleanupResult> {
  const result: LegacyCleanupResult = {
    success: true,
    deletedSessions: 0,
    deletedMessages: 0,
    deletedSessionMembers: 0,
    deletedWorkspaceTasks: 0,
    deletedLegacyTasks: 0,
    deletedLegacyAgents: 0,
    deletedEmptyWorkspaces: 0,
    cleanedSettings: 0,
    deletedLegacySpecDirs: 0,
  }

  await db.transaction(async (tx) => {
    const sessionRows = await tx.select().from(sessions)
    const workspaceTaskRows = await tx.select().from(workspaceTasks)
    const groupWorkspaceIds = new Set(
      sessionRows
        .filter((session) => session.type === 'group' && session.workspaceId)
        .map((session) => session.workspaceId!),
    )
    const taskSessionIds = new Set(
      workspaceTaskRows
        .filter((task) => task.runId && task.sessionId)
        .map((task) => task.sessionId!),
    )

    const legacySessionIds = sessionRows
      .filter((session) => shouldDeleteLegacySession(session, groupWorkspaceIds, taskSessionIds))
      .map((session) => session.id)

    const legacyWorkspaceTaskIds = workspaceTaskRows
      .filter((task) => shouldDeleteLegacyWorkspaceTask(task, legacySessionIds))
      .map((task) => task.id)

    for (const taskId of legacyWorkspaceTaskIds) {
      await tx.delete(workspaceTasks).where(eq(workspaceTasks.id, taskId))
    }
    result.deletedWorkspaceTasks = legacyWorkspaceTaskIds.length

    for (const sessionId of legacySessionIds) {
      const memberRows = await tx
        .select({ id: sessionMembers.id })
        .from(sessionMembers)
        .where(eq(sessionMembers.sessionId, sessionId))
      result.deletedSessionMembers += memberRows.length
      await tx.delete(messages).where(eq(messages.sessionId, sessionId))
      await tx.delete(sessionMembers).where(eq(sessionMembers.sessionId, sessionId))
      await tx.delete(sessions).where(eq(sessions.id, sessionId))
    }
    result.deletedSessions = legacySessionIds.length

    const legacyTaskRows = await tx.select({ id: tasks.id }).from(tasks)
    for (const task of legacyTaskRows) {
      await tx.delete(tasks).where(eq(tasks.id, task.id))
    }
    result.deletedLegacyTasks = legacyTaskRows.length

    const legacyAgentRows = await tx.select({ id: agents.id }).from(agents)
    for (const agent of legacyAgentRows) {
      await tx.delete(agents).where(eq(agents.id, agent.id))
    }
    result.deletedLegacyAgents = legacyAgentRows.length

    const workspaceRows = await tx.select({ id: workspaces.id, projectPath: workspaces.projectPath }).from(workspaces)
    for (const workspace of workspaceRows) {
      const [remainingSession] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.workspaceId, workspace.id))
        .limit(1)
      const [remainingTask] = await tx
        .select({ id: workspaceTasks.id })
        .from(workspaceTasks)
        .where(eq(workspaceTasks.workspaceId, workspace.id))
        .limit(1)
      const [remainingAgent] = await tx
        .select({ id: workspaceAgents.id })
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, workspace.id))
        .limit(1)
      if (remainingSession || remainingTask || remainingAgent) continue
      await tx.delete(workspaces).where(eq(workspaces.id, workspace.id))
      result.deletedEmptyWorkspaces += 1
    }

    for (const workspace of workspaceRows) {
      const specsDir = workspace.projectPath ? join(workspace.projectPath, '.agenthub', 'specs') : null
      if (!specsDir || !existsSync(specsDir)) continue
      rmSync(specsDir, { recursive: true, force: true })
      result.deletedLegacySpecDirs += 1
    }

    const [librarySetting] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, agentLibrarySettingKey))
      .limit(1)
    const cleanedLibrary = cleanAgentLibrarySetting(librarySetting?.value)
    if (librarySetting && cleanedLibrary !== librarySetting.value) {
      if (cleanedLibrary) {
        await tx
          .update(settings)
          .set({ value: cleanedLibrary, updatedAt: new Date() })
          .where(eq(settings.key, agentLibrarySettingKey))
      } else {
        await tx.delete(settings).where(eq(settings.key, agentLibrarySettingKey))
      }
      result.cleanedSettings += 1
    }
  })

  return result
}

function shouldDeleteLegacySession(
  session: SessionRow,
  groupWorkspaceIds: Set<string>,
  taskSessionIds: Set<string>,
) {
  if (session.type === 'group') return false
  if (!session.workspaceId) return false

  const metadata = asRecord(session.metadata)
  const kind = typeof metadata.kind === 'string' ? metadata.kind : ''

  if (kind === 'orchestrator-task') {
    return !isCompleteOrchestratorTaskSession(session, metadata) || !taskSessionIds.has(session.id)
  }

  if (hasOrchestratorTaskTrace(metadata)) return true
  if (kind === 'workspace-agent-child') return true

  if (kind === 'agent-direct') {
    const savedAgentId = typeof metadata.savedAgentId === 'string' ? metadata.savedAgentId.trim() : ''
    return !savedAgentId && groupWorkspaceIds.has(session.workspaceId)
  }

  return Boolean(session.workspaceAgentId || metadata.hiddenFromSessionTree)
}

function shouldDeleteLegacyWorkspaceTask(task: WorkspaceTaskRow, legacySessionIds: string[]) {
  if (!task.runId) return true
  return Boolean(task.sessionId && legacySessionIds.includes(task.sessionId))
}

function isCompleteOrchestratorTaskSession(session: SessionRow, metadata: Record<string, unknown>) {
  return Boolean(
    session.workspaceId &&
      session.workspaceAgentId &&
      typeof metadata.orchestratorRunId === 'string' &&
      metadata.orchestratorRunId.trim() &&
      typeof metadata.orchestratorTaskId === 'string' &&
      metadata.orchestratorTaskId.trim(),
  )
}

function hasOrchestratorTaskTrace(metadata: Record<string, unknown>) {
  return Boolean(
    metadata.orchestratorTaskId ||
      metadata.orchestratorRunId ||
      metadata.hiddenFromSessionTree,
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cleanAgentLibrarySetting(value?: string | null) {
  if (!value) return value ?? null
  try {
    const parsed = JSON.parse(value)
    const agentsInput = Array.isArray(parsed) ? parsed : parsed?.agents
    const relationsInput = Array.isArray(parsed?.relations) ? parsed.relations : []
    const agents = Array.isArray(agentsInput)
      ? agentsInput.filter((agent) => !isPlaceholderAgent(agent))
      : []
    const ids = new Set(
      agents
        .map((agent) => typeof agent?.id === 'string' ? agent.id : '')
        .filter(Boolean),
    )
    const relations = relationsInput.filter(
      (relation: any) =>
        typeof relation?.sourceAgentId === 'string' &&
        typeof relation?.targetAgentId === 'string' &&
        ids.has(relation.sourceAgentId) &&
        ids.has(relation.targetAgentId),
    )
    if (!agents.length && !relations.length) return null
    return JSON.stringify({ schemaVersion: 2, agents, relations })
  } catch {
    return null
  }
}

function isPlaceholderAgent(agent: any) {
  return (
    normalizeAgentText(agent?.name) === 'new agent' &&
    normalizeAgentText(agent?.role) === '协作' &&
    normalizeAgentText(agent?.description) ===
      normalizeAgentText('描述这个 Agent 的职责、产出和适合处理的任务。') &&
    normalizeAgentText(agent?.systemPrompt) ===
      normalizeAgentText('你是 AgentHub 中的协作 Agent。先理解目标，再给出清晰、可执行的结果。')
  )
}

function normalizeAgentText(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}
