import {
  db,
  workspaces,
  workspaceAgents,
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
  return { workspace: ws, agents, tasks }
}

export async function ensureWorkspace(id: string, ownerId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!ws || ws.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
  }
  return ws
}

const CLASSIC_AGENTS = [
  { name: 'Architect', role: '规划', systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。', color: '#6366f1' },
  { name: 'Coder', role: '实现', systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文,再小步迭代。', color: '#10b981' },
  { name: 'Researcher', role: '研究', systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点。给出参考来源。', color: '#f59e0b' },
  { name: 'Reviewer', role: '审查', systemPrompt: '你是审查者。检查风险、交互漏洞和缺失的测试。直接、克制、不绕弯。', color: '#ef4444' },
]

export async function seedClassicAgents(workspaceId: string) {
  await db.insert(workspaceAgents).values(
    CLASSIC_AGENTS.map((agent, index) => ({ ...agent, workspaceId, orderIdx: index }))
  )
}
