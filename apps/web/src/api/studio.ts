import { apiFetch } from './client'

export type StudioTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface StudioKpi {
  label: string
  value: string
  delta: string
  tone: StudioTone
}

export interface StudioRow {
  id: string
  name: string
  scope: string
  metric: string
  status: string
  kind: string
  updatedAt: string
  description: string
  tags: string[]
}

export interface StudioModule {
  key: string
  title: string
  eyebrow: string
  description: string
  action: string
  docsHref?: string
  columns: [string, string, string, string]
  capabilities: string[]
  kpis: StudioKpi[]
  rows: StudioRow[]
}

export interface StudioEvent {
  id: string
  moduleKey: string
  action: string
  summary: string
  status: 'success' | 'queued' | 'failed'
  createdAt: string
  payload?: unknown
}

export interface StudioTrace {
  id: string
  span: string
  status: string
  latency: string
  input: string
  output: string
  tokens: number
  startedAt: string
}

export interface StudioReviewItem {
  id: string
  title: string
  status: '通过' | '待确认' | '退回'
  reviewer: string
  note: string
}

export interface StudioEvaluationResult {
  id: string
  dataset: string
  scorer: string
  score: number
  status: '通过' | '关注' | '失败'
  createdAt: string
  summary: string
}

export interface StudioAgent {
  id: string
  name: string
  model: string
  provider: string
  temperature: number
  maxSteps: number
  memoryEnabled: boolean
  tracingEnabled: boolean
  prompt: string
  tools: string[]
  workflows: string[]
  processors: string[]
  scorers: string[]
  datasets: string[]
  memoryThreads: Array<{ id: string; title: string; messages: number; updatedAt: string }>
  traces: StudioTrace[]
  reviews: StudioReviewItem[]
  evaluations: StudioEvaluationResult[]
}

export type StudioClusterTopology = 'supervisor' | 'pipeline' | 'committee' | 'swarm'

export interface StudioClusterMember {
  agentId: string
  name: string
  role: string
  model: string
  status: string
  load: number
  tools: string[]
  handoffPolicy: string
}

export interface StudioClusterRoute {
  id: string
  from: string
  to: string
  condition: string
  mode: 'delegate' | 'parallel' | 'review' | 'fallback'
  status: string
}

export interface StudioClusterRun {
  id: string
  title: string
  status: string
  startedAt: string
  latency: string
  tokens: number
  owner: string
  route: string[]
  summary: string
}

export interface StudioAgentCluster {
  id: string
  name: string
  topology: StudioClusterTopology
  status: string
  description: string
  supervisorId: string
  members: StudioClusterMember[]
  routes: StudioClusterRoute[]
  runs: StudioClusterRun[]
  policies: Array<{ label: string; value: string }>
}

export async function fetchStudioModule(moduleKey: string, query = '', status = '全部') {
  const search = new URLSearchParams()
  if (query) search.set('query', query)
  if (status && status !== '全部') search.set('status', status)
  const queryString = search.toString()
  const res = await apiFetch(`/api/studio/modules/${moduleKey}${queryString ? `?${queryString}` : ''}`)
  return (await res.json()) as StudioModule
}

export async function runStudioAction(moduleKey: string, action = 'run', payload?: unknown) {
  const res = await apiFetch(`/api/studio/modules/${moduleKey}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action, payload }),
  })
  return (await res.json()) as StudioEvent
}

export async function fetchStudioEvents(limit = 12) {
  const res = await apiFetch(`/api/studio/events?limit=${limit}`)
  const data = (await res.json()) as { items?: StudioEvent[] }
  return data.items ?? []
}

export async function fetchAgentStudio(agentId: string) {
  const res = await apiFetch(`/api/studio/agents/${agentId}`)
  return (await res.json()) as StudioAgent
}

export async function saveAgentStudio(agentId: string, patch: Partial<StudioAgent>) {
  const res = await apiFetch(`/api/studio/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return (await res.json()) as StudioAgent
}

export async function fetchAgentTabData<T>(agentId: string, tab: string) {
  const res = await apiFetch(`/api/studio/agents/${agentId}/tabs/${tab}`)
  return (await res.json()) as T
}

export async function runAgentEvaluation(agentId: string, dataset: string, scorer: string) {
  const res = await apiFetch(`/api/studio/agents/${agentId}/evaluations`, {
    method: 'POST',
    body: JSON.stringify({ dataset, scorer }),
  })
  return (await res.json()) as StudioEvaluationResult
}

export async function updateAgentReview(agentId: string, reviewId: string, status: StudioReviewItem['status']) {
  const res = await apiFetch(`/api/studio/agents/${agentId}/reviews/${reviewId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  return (await res.json()) as StudioReviewItem
}

export async function fetchAgentClusters() {
  const res = await apiFetch('/api/studio/clusters')
  const data = (await res.json()) as { items?: StudioAgentCluster[] }
  return data.items ?? []
}

export async function fetchAgentCluster(clusterId: string) {
  const res = await apiFetch(`/api/studio/clusters/${clusterId}`)
  return (await res.json()) as StudioAgentCluster
}

export async function saveAgentCluster(clusterId: string, patch: Partial<StudioAgentCluster>) {
  const res = await apiFetch(`/api/studio/clusters/${clusterId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return (await res.json()) as StudioAgentCluster
}

export async function runAgentCluster(clusterId: string, input?: unknown) {
  const res = await apiFetch(`/api/studio/clusters/${clusterId}/runs`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  })
  return (await res.json()) as StudioClusterRun
}
