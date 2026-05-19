import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import {
  getAgentCluster,
  getStudioAgent,
  getStudioModule,
  listAgentClusters,
  runAgentCluster,
  runAgentEvaluation,
  runStudioAction,
  updateStudioAgent,
  type StudioAgentCluster,
  type StudioClusterRun,
  type StudioRow,
} from '../services/studio-registry'

export const mastraCompatRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/agents', (c) => c.json(rowRecord('agents', agentFromRow)))
  .get('/agents/providers', (c) =>
    c.json({
      providers: [
        { id: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-1'] },
        { id: 'openai', name: 'OpenAI', models: ['gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini'] },
        { id: 'google', name: 'Google', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
      ],
    }),
  )
  .get('/agents/:agentId', (c) => c.json(getStudioAgent(c.req.param('agentId'))))
  .patch('/agents/:agentId', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(updateStudioAgent(c.req.param('agentId'), body))
  })
  .get('/networks', (c) => c.json(Object.fromEntries(listAgentClusters().map((cluster) => [cluster.id, networkFromCluster(cluster)]))))
  .get('/agent-networks', (c) => c.json(Object.fromEntries(listAgentClusters().map((cluster) => [cluster.id, networkFromCluster(cluster)]))))
  .get('/networks/v-next', (c) => c.json(Object.fromEntries(listAgentClusters().map((cluster) => [cluster.id, networkFromCluster(cluster)]))))
  .get('/networks/v-next/:networkId', (c) => c.json(networkFromCluster(getAgentCluster(c.req.param('networkId')))))
  .get('/networks/:networkId', (c) => c.json(networkFromCluster(getAgentCluster(c.req.param('networkId')))))
  .post('/networks/v-next/:networkId/generate', async (c) => {
    const networkId = c.req.param('networkId')
    const body = await c.req.json().catch(() => ({}))
    const run = runAgentCluster(networkId, body)
    return c.json(networkRunResponse(networkId, run))
  })
  .post('/networks/:networkId/generate', async (c) => {
    const networkId = c.req.param('networkId')
    const body = await c.req.json().catch(() => ({}))
    const run = runAgentCluster(networkId, body)
    return c.json(networkRunResponse(networkId, run))
  })
  .post('/networks/v-next/:networkId/stream', async (c) => {
    const networkId = c.req.param('networkId')
    const body = await c.req.json().catch(() => ({}))
    const run = runAgentCluster(networkId, body)
    return c.json(networkStreamResponse(networkId, run))
  })
  .post('/networks/:networkId/stream', async (c) => {
    const networkId = c.req.param('networkId')
    const body = await c.req.json().catch(() => ({}))
    const run = runAgentCluster(networkId, body)
    return c.json(networkStreamResponse(networkId, run))
  })
  .get('/tools', (c) => c.json(rowRecord('tools', toolFromRow)))
  .get('/tools/:toolId', (c) => c.json(toolFromRow(requireRow('tools', c.req.param('toolId')))))
  .post('/tools/:toolId/execute', async (c) => {
    const toolId = c.req.param('toolId')
    const body = await c.req.json().catch(() => ({}))
    const row = requireRow('tools', toolId)
    const event = runStudioAction('tools', 'execute', { toolId, input: body })
    return c.json({
      id: event.id,
      toolId,
      status: row.status === '需要授权' ? 'requires_approval' : 'success',
      output: row.id === 'weatherInfo' ? sampleWeatherOutput(body) : { message: `${row.name} 已执行`, input: body },
      traceId: 'trace_tool_014',
      createdAt: event.createdAt,
    })
  })
  .get('/processors', (c) => c.json(rowRecord('processors', rowResource)))
  .get('/workflows', (c) => c.json(rowRecord('workflows', workflowFromRow)))
  .get('/workflows/:workflowId', (c) => c.json(workflowFromRow(requireRow('workflows', c.req.param('workflowId')))))
  .post('/workflows/:workflowId/start-async', async (c) => {
    const workflowId = c.req.param('workflowId')
    const input = await c.req.json().catch(() => ({}))
    const event = runStudioAction('workflows', 'run', { workflowId, input })
    return c.json({
      runId: event.id,
      workflowId,
      status: 'running',
      startedAt: event.createdAt,
      steps: workflowSteps(workflowId),
    })
  })
  .get('/agent-builder', (c) => c.json(rowRecord('agent-builder', workflowFromRow)))
  .get('/mcp/v0/servers', (c) => c.json({ servers: getStudioModule('mcps').rows.map(mcpFromRow) }))
  .get('/mcp/v0/servers/:serverId', (c) => c.json(mcpFromRow(requireRow('mcps', c.req.param('serverId')))))
  .get('/mcp/v0/servers/:serverId/tools', (c) => {
    const serverId = c.req.param('serverId')
    return c.json({ tools: mcpTools(serverId) })
  })
  .get('/mcp/v0/servers/:serverId/resources', (c) => {
    const serverId = c.req.param('serverId')
    return c.json({ resources: mcpResources(serverId) })
  })
  .get('/memory/threads', (c) => c.json({ threads: getStudioAgent('weather-agent').memoryThreads, total: 2, page: 0, perPage: 100, hasMore: false }))
  .get('/memory/threads/:threadId/messages', (c) => {
    const threadId = c.req.param('threadId')
    return c.json({ messages: memoryMessages(threadId) })
  })
  .get('/memory/config', (c) => c.json({ enabled: true, provider: 'local', agentId: c.req.query('agentId') ?? 'weather-agent' }))
  .get('/memory/status', (c) => c.json({ status: 'ready', buffer: 'empty', threads: getStudioAgent('weather-agent').memoryThreads.length }))
  .get('/scorers', (c) => c.json(rowRecord('scorers', scorerFromRow)))
  .get('/scores', (c) => c.json({ scores: getStudioAgent('weather-agent').evaluations }))
  .post('/scores', async (c) => {
    const body = (await c.req.json<{ agentId?: string; dataset?: string; scorer?: string }>().catch(() => ({}))) as {
      agentId?: string
      dataset?: string
      scorer?: string
    }
    return c.json(runAgentEvaluation(body.agentId ?? 'weather-agent', body.dataset ?? 'weather-basic', body.scorer ?? 'answer-relevance'))
  })
  .get('/datasets', (c) => c.json({ datasets: getStudioModule('datasets').rows.map(datasetFromRow), pagination: pagination(3) }))
  .get('/datasets/:datasetId', (c) => c.json(datasetFromRow(requireRow('datasets', c.req.param('datasetId')))))
  .get('/datasets/:datasetId/items', (c) => c.json({ items: datasetItems(c.req.param('datasetId')), pagination: pagination(3) }))
  .post('/datasets/:datasetId/experiments', async (c) => {
    const datasetId = c.req.param('datasetId')
    const body = (await c.req.json<{ scorerIds?: string[]; agentId?: string }>().catch(() => ({}))) as {
      scorerIds?: string[]
      agentId?: string
    }
    const event = runStudioAction('experiments', 'run', { datasetId, ...body })
    return c.json({
      experimentId: event.id,
      datasetId,
      status: 'running',
      totalItems: datasetItems(datasetId).length,
      succeededCount: 0,
      failedCount: 0,
      startedAt: event.createdAt,
      completedAt: null,
      results: [],
    })
  })
  .get('/experiments', (c) => c.json({ experiments: getStudioModule('experiments').rows.map(experimentFromRow), pagination: pagination(3) }))
  .get('/experiments/review-summary', (c) => c.json({ counts: [{ experimentId: 'prompt-v2-regression', pending: 4, approved: 18, rejected: 1 }] }))
  .get('/logs/transports', (c) => c.json({ transports: ['console', 'studio-memory', 'agenthub-local'] }))
  .get('/logs', (c) => c.json({ logs: logEntries(), pagination: pagination(3) }))
  .get('/traces', (c) => c.json({ spans: traceEntries(), pagination: pagination(3) }))
  .get('/traces/:traceId', (c) => {
    const traceId = c.req.param('traceId')
    return c.json({ traceId, spans: traceEntries().filter((item) => item.traceId === traceId || traceId === 'trace_weather_001') })
  })
  .get('/traces/:traceId/spans/:spanId', (c) => {
    const spanId = c.req.param('spanId')
    const span = traceEntries().find((item) => item.spanId === spanId) ?? traceEntries()[0]!
    return c.json({ span })
  })
  .get('/metrics/names', (c) => c.json({ names: ['agent.runs', 'tokens.total', 'latency.p95', 'tool.approvals'] }))
  .get('/metrics/aggregate', (c) => c.json({ value: 128, unit: 'runs', window: '24h' }))
  .get('/metrics/time-series', (c) => c.json({ points: metricPoints() }))
  .get('/vectors', (c) => c.json({ vectors: getStudioModule('vectors').rows.map(rowResource) }))
  .get('/embedders', (c) => c.json({ embedders: getStudioModule('embedders').rows.map(rowResource) }))
  .get('/tool-providers', (c) => c.json({ providers: getStudioModule('tool-providers').rows.map(rowResource) }))
  .get('/processor-providers', (c) => c.json({ providers: getStudioModule('processor-providers').rows.map(rowResource) }))
  .get('/workspaces', (c) => c.json({ workspaces: getStudioModule('workspaces').rows.map(rowResource) }))
  .get('/stored/workspaces', (c) => c.json({ workspaces: getStudioModule('workspaces').rows.map(rowResource), pagination: pagination(3) }))
  .get('/background-tasks', (c) => c.json({ tasks: getStudioModule('background-tasks').rows.map(taskFromRow), pagination: pagination(3) }))
  .get('/background-tasks/:taskId', (c) => c.json(taskFromRow(requireRow('background-tasks', c.req.param('taskId')))))
  .get('/schedules', (c) => c.json({ schedules: getStudioModule('schedules').rows.map(scheduleFromRow) }))
  .get('/schedules/:scheduleId', (c) => c.json(scheduleFromRow(requireRow('schedules', c.req.param('scheduleId')))))
  .post('/schedules/:scheduleId/pause', (c) => c.json({ ...scheduleFromRow(requireRow('schedules', c.req.param('scheduleId'))), status: 'paused' }))
  .post('/schedules/:scheduleId/resume', (c) => c.json({ ...scheduleFromRow(requireRow('schedules', c.req.param('scheduleId'))), status: 'active' }))
  .get('/system/packages', (c) => c.json({ runtime: 'bun', packages: ['@mastra/core', 'ai', 'hono', 'drizzle-orm'] }))
  .get('/builder/settings', (c) => c.json({ modelProvider: 'anthropic', model: getStudioAgent('weather-agent').model, storage: 'local' }))
  .get('/infrastructure/status', (c) => c.json({ status: 'ready', services: ['api', 'studio', 'database'] }))

function rowRecord(moduleKey: string, mapper: (row: StudioRow) => unknown) {
  return Object.fromEntries(getStudioModule(moduleKey).rows.map((row) => [row.id, mapper(row)]))
}

function requireRow(moduleKey: string, id: string): StudioRow {
  const row = getStudioModule(moduleKey).rows.find((item) => item.id === id)
  if (row) return row
  const fallback = getStudioModule(moduleKey).rows[0]
  if (!fallback) {
    throw new Error(`No rows available for module ${moduleKey}`)
  }
  return fallback
}

function rowResource(row: StudioRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    metric: row.metric,
    status: row.status,
    tags: row.tags,
    updatedAt: row.updatedAt,
  }
}

function agentFromRow(row: StudioRow) {
  const agent = getStudioAgent(row.id)
  return {
    ...rowResource(row),
    instructions: agent.prompt,
    provider: agent.provider,
    modelId: agent.model,
    tools: agent.tools,
    workflows: agent.workflows,
    memory: { enabled: agent.memoryEnabled },
    tracing: { enabled: agent.tracingEnabled },
  }
}

function networkFromCluster(cluster: StudioAgentCluster) {
  return {
    id: cluster.id,
    name: cluster.name,
    description: cluster.description,
    topology: cluster.topology,
    status: cluster.status,
    routingAgentId: cluster.supervisorId,
    agents: Object.fromEntries(
      cluster.members.map((member) => [
        member.agentId,
        {
          id: member.agentId,
          name: member.name,
          role: member.role,
          modelId: member.model,
          status: member.status,
          tools: member.tools,
          handoffPolicy: member.handoffPolicy,
        },
      ]),
    ),
    routes: cluster.routes,
    runs: cluster.runs,
    policies: cluster.policies,
  }
}

function networkRunResponse(networkId: string, run: StudioClusterRun) {
  return {
    runId: run.id,
    networkId,
    status: run.status,
    finalResult: {
      text: `${getAgentCluster(networkId).name} 已完成一次本地 network.generate。`,
      route: run.route,
    },
    usage: { totalTokens: run.tokens },
    startedAt: run.startedAt,
  }
}

function networkStreamResponse(networkId: string, run: StudioClusterRun) {
  return {
    runId: run.id,
    networkId,
    events: [
      { type: 'network-execution-event-start', runId: run.id, networkId, route: run.route },
      { type: 'network-execution-event-step-finish', runId: run.id, networkId, step: run.route[run.route.length - 1] ?? getAgentCluster(networkId).supervisorId },
      { type: 'network-execution-event-finish', runId: run.id, networkId, finalResult: run.summary },
    ],
  }
}

function toolFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    schema: {
      input: row.id === 'weatherInfo' ? { location: 'string', unit: 'celsius|fahrenheit' } : { query: 'string' },
      output: row.id === 'weatherInfo' ? { temperature: 'number', humidity: 'number', wind: 'string' } : { result: 'unknown' },
    },
    requiresApproval: row.status === '需要授权',
  }
}

function workflowFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    steps: workflowSteps(row.id),
    latestRun: { status: row.status, duration: row.metric },
  }
}

function mcpFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    transport: row.scope,
    toolCount: Number.parseInt(row.metric, 10) || mcpTools(row.id).length,
    resources: mcpResources(row.id),
  }
}

function scorerFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    type: row.scope,
    scale: row.metric,
  }
}

function datasetFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    itemCount: Number.parseInt(row.scope, 10) || datasetItems(row.id).length,
    version: row.metric,
  }
}

function experimentFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    datasetId: row.scope,
    progress: row.metric,
  }
}

function taskFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    taskId: row.id,
    progress: row.metric,
    entityId: row.scope,
  }
}

function scheduleFromRow(row: StudioRow) {
  return {
    ...rowResource(row),
    scheduleId: row.id,
    workflowId: row.scope,
    nextFireAt: row.metric,
    status: row.status === '在线' ? 'active' : 'paused',
  }
}

function sampleWeatherOutput(input: unknown) {
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    location: body.location ?? 'Shanghai',
    temperature: 24,
    humidity: 68,
    wind: '东南风 3 级',
    precipitation: '20%',
  }
}

function workflowSteps(workflowId: string) {
  const base = [
    { id: 'receive-input', label: '接收输入', status: 'success', duration: '24ms' },
    { id: 'resolve-context', label: '解析上下文', status: 'success', duration: '42ms' },
    { id: 'call-agent', label: '调用 Agent', status: workflowId.includes('handoff') ? 'waiting' : 'success', duration: '1.3s' },
    { id: 'persist-result', label: '写入结果', status: workflowId.includes('handoff') ? 'pending' : 'success', duration: '120ms' },
  ]
  if (workflowId.includes('dataset')) {
    return [
      ...base.slice(0, 2),
      { id: 'load-dataset', label: '读取数据集', status: 'success', duration: '180ms' },
      { id: 'score-items', label: '批量评分', status: 'running', duration: '2.4s' },
      { id: 'write-experiment', label: '写入实验', status: 'pending', duration: '-' },
    ]
  }
  return base
}

function mcpTools(serverId: string) {
  if (serverId === 'filesystem') {
    return [
      { id: 'read-file', name: 'read-file', description: '读取工作区文件' },
      { id: 'write-file', name: 'write-file', description: '写入工作区文件' },
      { id: 'grep', name: 'grep', description: '搜索文件内容' },
    ]
  }
  if (serverId === 'browser') {
    return [
      { id: 'open-page', name: 'open-page', description: '打开页面' },
      { id: 'screenshot', name: 'screenshot', description: '截图验证' },
    ]
  }
  return [{ id: 'list-repositories', name: 'list-repositories', description: '列出仓库' }]
}

function mcpResources(serverId: string) {
  return [
    { uri: `mcp://${serverId}/tools`, name: `${serverId} tools` },
    { uri: `mcp://${serverId}/health`, name: `${serverId} health` },
  ]
}

function memoryMessages(threadId: string) {
  return [
    { id: `${threadId}-1`, role: 'user', content: '上海明天天气怎么样？', createdAt: new Date().toISOString() },
    { id: `${threadId}-2`, role: 'assistant', content: '我会查询上海的温度、湿度、风力和降水概率。', createdAt: new Date().toISOString() },
  ]
}

function datasetItems(datasetId: string) {
  return [
    { id: `${datasetId}-001`, input: '上海明天天气？', expected: '包含温度、湿度、风力、降水', version: 3 },
    { id: `${datasetId}-002`, input: '北京周末会下雨吗？', expected: '回答降水概率并给出建议', version: 3 },
    { id: `${datasetId}-003`, input: '杭州适合穿什么？', expected: '结合天气给出穿衣建议', version: 3 },
  ]
}

function logEntries() {
  return getStudioModule('logs').rows.map((row) => ({
    id: row.id,
    timestamp: new Date().toISOString(),
    level: row.scope,
    message: row.metric,
    entityName: row.name,
    traceId: row.id === 'log-120122' ? 'trace_weather_001' : undefined,
  }))
}

function traceEntries() {
  return getStudioModule('observability').rows.map((row, index) => ({
    traceId: row.id,
    spanId: `${row.id}-span-${index + 1}`,
    name: row.name,
    entityName: row.scope,
    status: row.status,
    duration: row.metric,
    parentSpanId: index === 0 ? null : 'trace_weather_001-span-1',
    attributes: { kind: row.kind, tags: row.tags },
  }))
}

function metricPoints() {
  return Array.from({ length: 8 }, (_, index) => ({
    timestamp: new Date(Date.now() - (7 - index) * 60 * 60 * 1000).toISOString(),
    value: 80 + index * 7,
  }))
}

function pagination(total: number) {
  return { page: 0, perPage: 100, total, hasMore: false }
}
