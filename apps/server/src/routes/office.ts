import { Hono } from 'hono'
import { db, workspaceAgents, sessions, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { ensureStarOfficeRunning, getStarOfficeRuntimeStatus } from '../services/star-office-service'
import { ensureStarOfficeAgent, starOfficeStateForProfile, pushStarOfficeAgentState } from '../services/star-office-bridge'
import { logger } from '../lib/logger'
import type { AgentProfile } from '../services/runtime'

export const officeRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/status', async (c) => {
    const status = await getStarOfficeRuntimeStatus()
    return c.json(status)
  })
  .post('/start', async (c) => {
    const status = await ensureStarOfficeRunning()
    return c.json(status)
  })
  .post('/join-agents', async (c) => {
    const { sessionId } = await c.req.json<{ sessionId?: string }>()
    if (!sessionId) return c.json({ ok: false, message: 'sessionId required' }, 400)

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session?.workspaceId) {
      return c.json({ ok: false, message: 'Session has no workspace' }, 400)
    }

    const agents = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, session.workspaceId))

    const joined: string[] = []
    for (const agent of agents) {
      try {
        const profile: AgentProfile = {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          description: agent.description,
          runtimeType: agent.runtimeType as 'llm' | 'code-agent',
          codeAgentType: agent.codeAgentType as AgentProfile['codeAgentType'],
          roleProfile: agent.roleProfile as Record<string, unknown> | null,
          capabilityTags: agent.capabilityTags ?? [],
          toolPermissions: agent.toolPermissions ?? [],
          sandboxPolicy:
            agent.sandboxPolicy === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
          contextPolicy: agent.contextPolicy as 'recent-only' | 'pinned-recent' | 'workspace-aware',
          approvalRequired: agent.approvalRequired,
        }
        await ensureStarOfficeAgent(profile)
        joined.push(agent.name)
      } catch (err) {
        logger.debug({ err: err instanceof Error ? err.message : String(err), agent: agent.name }, 'Failed to join agent to office')
      }
    }

    return c.json({ ok: true, joined, total: agents.length })
  })
