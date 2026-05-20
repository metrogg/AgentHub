import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import {
  createAgentCluster,
  getAgentTabData,
  getAgentCluster,
  getAgentClusterTabData,
  getStudioAgent,
  getStudioModule,
  listAgentClusters,
  listStudioEvents,
  listStudioModules,
  runAgentCluster,
  runAgentEvaluation,
  runStudioAction,
  updateAgentCluster,
  updateReviewItem,
  updateStudioAgent,
  type StudioReviewItem,
} from '../services/studio-registry'

export const studioRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/modules', (c) => c.json({ items: listStudioModules() }))
  .get('/modules/:moduleKey', (c) => {
    const moduleKey = c.req.param('moduleKey')
    const query = c.req.query('query') ?? ''
    const status = c.req.query('status') ?? '全部'
    return c.json(getStudioModule(moduleKey, query, status))
  })
  .post('/modules/:moduleKey/actions', async (c) => {
    const moduleKey = c.req.param('moduleKey')
    const body = (await c.req.json<{ action?: string; payload?: unknown }>().catch(() => ({}))) as {
      action?: string
      payload?: unknown
    }
    return c.json(runStudioAction(moduleKey, body.action ?? 'run', body.payload))
  })
  .get('/events', (c) => {
    const limit = Number(c.req.query('limit') ?? 12)
    return c.json({ items: listStudioEvents(Number.isFinite(limit) ? limit : 12) })
  })
  .get('/clusters', (c) => c.json({ items: listAgentClusters() }))
  .post('/clusters', async (c) => {
    const body = (await c.req.json<{ seedId?: string }>().catch(() => ({}))) as { seedId?: string }
    return c.json(createAgentCluster(body.seedId))
  })
  .get('/clusters/:clusterId', (c) => {
    const clusterId = c.req.param('clusterId')
    return c.json(getAgentCluster(clusterId))
  })
  .patch('/clusters/:clusterId', async (c) => {
    const clusterId = c.req.param('clusterId')
    const body = await c.req.json().catch(() => ({}))
    return c.json(updateAgentCluster(clusterId, body))
  })
  .post('/clusters/:clusterId/runs', async (c) => {
    const clusterId = c.req.param('clusterId')
    const body = await c.req.json().catch(() => ({}))
    return c.json(runAgentCluster(clusterId, body))
  })
  .get('/clusters/:clusterId/tabs/:tab', (c) => {
    const clusterId = c.req.param('clusterId')
    const tab = c.req.param('tab')
    return c.json(getAgentClusterTabData(clusterId, tab))
  })
  .get('/agents/:agentId', (c) => {
    const agentId = c.req.param('agentId')
    return c.json(getStudioAgent(agentId))
  })
  .patch('/agents/:agentId', async (c) => {
    const agentId = c.req.param('agentId')
    const body = await c.req.json().catch(() => ({}))
    return c.json(updateStudioAgent(agentId, body))
  })
  .get('/agents/:agentId/tabs/:tab', (c) => {
    const agentId = c.req.param('agentId')
    const tab = c.req.param('tab')
    return c.json(getAgentTabData(agentId, tab))
  })
  .post('/agents/:agentId/evaluations', async (c) => {
    const agentId = c.req.param('agentId')
    const body = (await c.req.json<{ dataset?: string; scorer?: string }>().catch(() => ({}))) as {
      dataset?: string
      scorer?: string
    }
    return c.json(runAgentEvaluation(agentId, body.dataset ?? 'weather-basic', body.scorer ?? 'answer-relevance'))
  })
  .patch('/agents/:agentId/reviews/:reviewId', async (c) => {
    const agentId = c.req.param('agentId')
    const reviewId = c.req.param('reviewId')
    const body = (await c.req.json<{ status?: StudioReviewItem['status'] }>().catch(() => ({}))) as {
      status?: StudioReviewItem['status']
    }
    const item = updateReviewItem(agentId, reviewId, body.status ?? '通过')
    if (!item) return c.json({ error: 'Review item not found' }, 404)
    return c.json(item)
  })
