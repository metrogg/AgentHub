import {
  db,
  workspaces,
  workspaceAgents,
  workspaceAgentRelations,
  workspaceTasks,
  eq,
  asc,
} from '@agenthub/db'
import { HTTPException } from 'hono/http-exception'

export async function loadWorkspaceFull(id: string, ownerId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!ws || ws.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
  }
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, id))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.workspaceId, id))
    .orderBy(asc(workspaceTasks.orderIdx), asc(workspaceTasks.createdAt))
  const agentRelations = await db
    .select()
    .from(workspaceAgentRelations)
    .where(eq(workspaceAgentRelations.workspaceId, id))
    .orderBy(asc(workspaceAgentRelations.createdAt))
  return { workspace: ws, agents, tasks, agentRelations }
}

export async function ensureWorkspace(id: string, ownerId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!ws || ws.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
  }
  return ws
}

