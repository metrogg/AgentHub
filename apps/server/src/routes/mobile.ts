import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { db, sessions, workspaces, workspaceAgents, workspaceTasks, orchestratorRuns, settings, users, eq, and, desc, asc } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../lib/error'
import { env } from '../env'
import { getRuntimeServerPort } from '../lib/runtime-server'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { getCodingToolsWorkbenchStatus } from './coding-tools'
import { getLlmRuntimeStatus } from '../services/llm-client'
import { globalSkillRegistry } from '../services/skill-registry'
import { getStarOfficeRuntimeStatus } from '../services/star-office-service'
import { createAutoWorkspaceFolder } from '../services/workspace/auto-workspace'
import { ensureGroupSession } from '../services/workspace/session-manager'
import { listRoomLastMessagePreviews } from '../services/rooms/room-last-message'

const PAIRING_TTL_MS = 2 * 60 * 1000
const AGENT_LIBRARY_SETTING_KEY = 'AGENT_LIBRARY'
const execFileAsync = promisify(execFile)
type WorkspaceCodeAgentType = 'codex' | 'claude-code' | 'opencode' | 'gemini'

interface PairingRecord {
  code: string
  baseUrl: string
  baseUrls: string[]
  webUrl: string
  webUrls: string[]
  expiresAt: number
}

const pairings = new Map<string, PairingRecord>()
const mobileEvents: Array<{ type: string; message: string; at: string }> = []

export const mobileRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('/pair/start', authMiddleware)
  .use('/agents/*', authMiddleware)
  .use('/sync', authMiddleware)
  .use('/workbench', authMiddleware)
  .use('/connectivity', authMiddleware)
  .use('/firewall/open', authMiddleware)
  .get('/sync', async (c) => {
    const user = c.get('user')
    const [sessionList, workspaceList, savedLibrary, profile] = await Promise.all([
      db.select().from(sessions).where(eq(sessions.ownerId, user.sub)).orderBy(desc(sessions.updatedAt)),
      db.select().from(workspaces).where(eq(workspaces.ownerId, user.sub)).orderBy(desc(workspaces.updatedAt)),
      readSavedAgentLibrary(),
      readMobileUserProfile(user.sub),
    ])
    const workspaceIds = workspaceList.map((workspace) => workspace.id)
    const agentList = workspaceIds.length
      ? await db
          .select()
          .from(workspaceAgents)
          .where(inArray(workspaceAgents.workspaceId, workspaceIds))
          .orderBy(asc(workspaceAgents.workspaceId), asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
      : []
    const contacts = mergeMobileContacts(
      contactsFromWorkspaceAgents(agentList),
      savedLibrary.found ? contactsFromSavedAgents(savedLibrary.agents) : [],
    )
    const lastMessages = await listRoomLastMessagePreviews(sessionList.map((session) => session.id))

    return c.json({
      sessions: sessionList.map((session) => ({
        ...session,
        lastMessage: lastMessages[session.id] ?? null,
      })),
      workspaces: workspaceList,
      agents: agentList,
      contacts,
      currentUser: profile,
    })
  })
  .get('/workbench', async (c) => {
    const user = c.get('user')
    return c.json(await buildMobileWorkbench(user.sub))
  })
  .post('/agents/:agentId/session', async (c) => {
    const user = c.get('user')
    const agentId = c.req.param('agentId')
    const savedLibrary = await readSavedAgentLibrary()
    const agent = savedLibrary.agents.find((item) => item.id === agentId)
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 通讯录未同步或该 Agent 不存在')
    const session = await ensureSavedAgentDirectSession(user.sub, agent)
    return c.json({ session })
  })
  .post('/agents/group-session', async (c) => {
    const user = c.get('user')
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}))
    const requestedAgentIds = Array.isArray(body.agentIds)
      ? uniqueStrings(body.agentIds.filter((id): id is string => typeof id === 'string'))
      : []
    if (!requestedAgentIds.length) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '请选择至少一个 Agent')
    }

    const savedLibrary = await readSavedAgentLibrary()
    const workspaceList = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.sub))
    const workspaceIds = workspaceList.map((workspace) => workspace.id)
    const agentList = workspaceIds.length
      ? await db.select().from(workspaceAgents).where(inArray(workspaceAgents.workspaceId, workspaceIds))
      : []
    const selectedAgents = resolveMobileContactAgents(requestedAgentIds, savedLibrary.agents, agentList)
    if (selectedAgents.length !== requestedAgentIds.length) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, '部分 Agent 未同步或已不存在，请刷新通讯录后重试')
    }

    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : ''
    const workspaceName = (title || defaultMobileGroupTitle(selectedAgents)).slice(0, 80)
    const folder = await createAutoWorkspaceFolder(workspaceName)
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: user.sub,
        name: workspaceName,
        goal: `邀请 ${selectedAgents.length} 个 Agent 组成群聊`,
        projectPath: folder.projectPath,
      })
      .returning()
    if (!workspace) throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '工作区创建失败')

    const invitedAgents: Array<typeof workspaceAgents.$inferSelect> = []
    for (const [index, agent] of selectedAgents.entries()) {
      const [createdAgent] = await db
        .insert(workspaceAgents)
        .values({
          ...savedAgentWorkspaceValues(agent),
          workspaceId: workspace.id,
          orderIdx: index,
        })
        .returning()
      if (createdAgent) invitedAgents.push(createdAgent)
    }
    if (invitedAgents.length !== selectedAgents.length) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 创建失败')
    }

    const session = await ensureGroupSession(
      workspace.id,
      user.sub,
      invitedAgents.map((agent) => agent.id),
    )
    return c.json({ session })
  })
  .get('/connectivity', async (c) => {
    return c.json(await mobileConnectivityStatus())
  })
  .post('/firewall/open', async (c) => {
    const port = getServerPort()
    const result = await openFirewallPort(port)
    pushMobileEvent({
      type: result.ok ? 'firewall.opened' : 'firewall.failed',
      message: result.message,
    })
    return c.json({
      ...result,
      diagnostics: await mobileConnectivityStatus(),
    })
  })
  .post('/pair/start', async (c) => {
    cleanupExpiredPairings()
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const requestedHost = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : ''
    const host = requestedHost || await pickLanAddress()
    const port = typeof body.port === 'number' ? body.port : getServerPort()
    const webPort = typeof body.webPort === 'number' ? body.webPort : env.AGENTHUB_WEB_DIST ? port : 5173
    const code = createPairingCode()
    const expiresAt = Date.now() + PAIRING_TTL_MS
    const hosts = uniqueHosts([host, ...listLanAddresses()])
    const baseUrls = hosts.map((item) => `http://${item}:${port}`)
    const webUrls = hosts.map((item) => `http://${item}:${webPort}`)
    const baseUrl = baseUrls[0] ?? `http://${host}:${port}`
    const webUrl = webUrls[0] ?? `http://${host}:${webPort}`
    const record: PairingRecord = { code, baseUrl, baseUrls, webUrl, webUrls, expiresAt }
    pairings.set(code, record)
    pushMobileEvent({
      type: 'pairing.started',
      message: `已生成移动端配对二维码：${baseUrl}`,
    })
    const payload = {
      version: 1,
      baseUrl,
      baseUrls,
      webUrl,
      webUrls,
      pairingCode: code,
      expiresAt: new Date(expiresAt).toISOString(),
    }
    return c.json({
      ...payload,
      ttlSeconds: Math.floor(PAIRING_TTL_MS / 1000),
      qrPayload: JSON.stringify(payload),
      localAddresses: listLanAddresses(),
      baseUrls,
    })
  })
  .post('/pair/confirm', async (c) => {
    cleanupExpiredPairings()
    pushMobileEvent({
      type: 'pairing.confirm.received',
      message: '收到移动端配对请求',
    })
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const code = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : ''
    if (!code) {
      pushMobileEvent({ type: 'pairing.confirm.failed', message: '移动端配对失败：配对码为空' })
      return c.json({ error: '配对码不能为空' }, 400)
    }
    const record = pairings.get(code)
    if (!record) {
      pushMobileEvent({ type: 'pairing.confirm.failed', message: '移动端配对失败：配对码不存在或已过期' })
      return c.json({ error: '配对码不存在或已过期' }, 404)
    }
    if (record.expiresAt < Date.now()) {
      pairings.delete(code)
      pushMobileEvent({ type: 'pairing.confirm.failed', message: '移动端配对失败：配对码已过期' })
      return c.json({ error: '配对码已过期' }, 410)
    }
    pairings.delete(code)
    const requestBaseUrl = requestOrigin(c.req.raw)
    const baseUrl = requestBaseUrl && isAllowedPairingBaseUrl(requestBaseUrl, record.baseUrls)
      ? requestBaseUrl
      : record.baseUrl
    const webUrl = record.webUrls.find((item) => sameHost(item, baseUrl)) ?? record.webUrl
    pushMobileEvent({
      type: 'pairing.confirmed',
      message: `移动端已配对：${baseUrl}`,
    })
    return c.json({
      baseUrl,
      webUrl,
      deviceName: typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim() : 'Android',
      authToken: `mobile_${randomUUID().replace(/-/g, '')}`,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
  })

interface SavedAgentConfig {
  id: string
  name: string
  role: string
  roleType?: string
  description?: string
  avatar?: string | null
  systemPrompt?: string
  roleProfile?: Record<string, unknown> | null
  color?: string
  modelId?: string | null
  runtimeType?: string
  codeAgentType?: string | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: string
  contextPolicy?: string
  autoInvoke?: boolean
  approvalRequired?: boolean
}

interface SavedAgentLibrary {
  found: boolean
  agents: SavedAgentConfig[]
}

interface MobileUserProfile {
  id: string
  name: string
  avatar: string | null
}

async function buildMobileWorkbench(ownerId: string) {
  const [workspaceList, savedLibrary, runtime, codingTools, skills, office, connectivity] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId)).orderBy(desc(workspaces.updatedAt)),
    readSavedAgentLibrary(),
    getLlmRuntimeStatus(),
    getCodingToolsWorkbenchStatus(),
    globalSkillRegistry.listSkills(),
    getStarOfficeRuntimeStatus(),
    mobileConnectivityStatus(),
  ])

  const workspaceIds = workspaceList.map((workspace) => workspace.id)
  const [agentList, taskList, sessionList, runList] = await Promise.all([
    workspaceIds.length
      ? db.select().from(workspaceAgents).where(inArray(workspaceAgents.workspaceId, workspaceIds))
      : Promise.resolve([] as Array<typeof workspaceAgents.$inferSelect>),
    workspaceIds.length
      ? db.select().from(workspaceTasks).where(inArray(workspaceTasks.workspaceId, workspaceIds))
      : Promise.resolve([] as Array<typeof workspaceTasks.$inferSelect>),
    workspaceIds.length
      ? db.select().from(sessions).where(inArray(sessions.workspaceId, workspaceIds))
      : Promise.resolve([] as Array<typeof sessions.$inferSelect>),
    workspaceIds.length
      ? db
          .select({
            id: orchestratorRuns.id,
            workspaceId: orchestratorRuns.workspaceId,
            groupSessionId: orchestratorRuns.groupSessionId,
            status: orchestratorRuns.status,
            conflictReport: orchestratorRuns.conflictReport,
            createdAt: orchestratorRuns.createdAt,
            updatedAt: orchestratorRuns.updatedAt,
            workspaceName: workspaces.name,
            sessionTitle: sessions.title,
          })
          .from(orchestratorRuns)
          .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
          .leftJoin(sessions, eq(sessions.id, orchestratorRuns.groupSessionId))
          .where(and(eq(workspaces.ownerId, ownerId), inArray(orchestratorRuns.workspaceId, workspaceIds)))
          .orderBy(desc(orchestratorRuns.createdAt))
      : Promise.resolve([] as Array<{
          id: string
          workspaceId: string
          groupSessionId: string
          status: string
          conflictReport: unknown
          createdAt: Date
          updatedAt: Date
          workspaceName: string | null
          sessionTitle: string | null
        }>),
  ])

  const agentCountByWorkspace = countBy(agentList, (agent) => agent.workspaceId)
  const taskCountByWorkspace = countBy(taskList, (task) => task.workspaceId)
  const sessionCountByWorkspace = countBy(sessionList, (session) => session.workspaceId ?? '')
  const activeRunCountByWorkspace = countBy(
    runList.filter((run) => ['planning', 'running', 'synthesizing'].includes(run.status)),
    (run) => run.workspaceId,
  )
  const workspaceById = new Map(workspaceList.map((workspace) => [workspace.id, workspace]))
  const agentById = new Map(agentList.map((agent) => [agent.id, agent]))
  const sessionById = new Map(sessionList.map((session) => [session.id, session]))
  const runById = new Map(runList.map((run) => [run.id, run]))
  const latestRunByWorkspace = new Map<string, typeof runList[number]>()
  for (const run of runList) {
    if (!latestRunByWorkspace.has(run.workspaceId)) latestRunByWorkspace.set(run.workspaceId, run)
  }

  return {
    generatedAt: new Date().toISOString(),
    runtime,
    codingTools,
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      rootPath: skill.rootPath,
      skillPath: skill.skillPath,
      source: skill.source,
    })),
    office,
    connectivity: {
      port: connectivity.port,
      localAddresses: connectivity.localAddresses,
      baseUrls: connectivity.baseUrls,
      message: connectivity.message,
    },
    workspaces: workspaceList.map((workspace) => {
      const latestRun = latestRunByWorkspace.get(workspace.id)
      return {
        id: workspace.id,
        name: workspace.name,
        goal: workspace.goal,
        projectPath: workspace.projectPath,
        agentCount: agentCountByWorkspace.get(workspace.id) ?? 0,
        taskCount: taskCountByWorkspace.get(workspace.id) ?? 0,
        sessionCount: sessionCountByWorkspace.get(workspace.id) ?? 0,
        activeRunCount: activeRunCountByWorkspace.get(workspace.id) ?? 0,
        groupSessionId: latestRun?.groupSessionId ?? null,
        updatedAt: workspace.updatedAt instanceof Date ? workspace.updatedAt.toISOString() : String(workspace.updatedAt ?? ''),
      }
    }),
    runs: runList.slice(0, 20).map((run) => ({
      id: run.id,
      workspaceId: run.workspaceId,
      workspaceName: run.workspaceName ?? '',
      groupSessionId: run.groupSessionId,
      sessionTitle: run.sessionTitle ?? '',
      status: run.status,
      conflictCount: countHumanConflictReports(run.conflictReport),
      createdAt: dateToIso(run.createdAt),
      updatedAt: dateToIso(run.updatedAt),
    })),
    tasks: taskList
      .slice()
      .sort((a, b) => dateSortValue(b.updatedAt ?? b.createdAt) - dateSortValue(a.updatedAt ?? a.createdAt))
      .slice(0, 80)
      .map((task) => {
        const workspace = workspaceById.get(task.workspaceId)
        const agent = task.agentId ? agentById.get(task.agentId) : undefined
        const run = task.runId ? runById.get(task.runId) : undefined
        const childSession = task.sessionId ? sessionById.get(task.sessionId) : undefined
        const requiresAttention = isTaskRequiringAttention(task.status, task.progressStatus, task.errorLog)
        return {
          id: task.id,
          workspaceId: task.workspaceId,
          workspaceName: workspace?.name ?? '',
          runId: task.runId,
          groupSessionId: run?.groupSessionId ?? null,
          sessionId: task.sessionId,
          sessionTitle: childSession?.title ?? run?.sessionTitle ?? '',
          agentId: task.agentId,
          agentName: agent?.name ?? '',
          agentRole: agent?.role ?? agent?.roleType ?? '',
          title: task.title,
          description: task.description,
          status: task.status,
          progressPercent: task.progressPercent ?? 0,
          progressStatus: task.progressStatus ?? '',
          phaseId: task.phaseId,
          orderIdx: task.orderIdx,
          requiresAttention,
          createdAt: dateToIso(task.createdAt),
          updatedAt: dateToIso(task.updatedAt),
          startedAt: dateToIso(task.startedAt),
          completedAt: dateToIso(task.completedAt),
          errorLog: task.errorLog,
        }
      }),
    savedAgentLibrary: {
      found: savedLibrary.found,
      count: savedLibrary.agents.length,
    },
  }
}

function dateToIso(value: Date | string | number | null | undefined) {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString()
}

function dateSortValue(value: Date | string | number | null | undefined) {
  if (!value) return 0
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

function countHumanConflictReports(value: unknown) {
  if (!Array.isArray(value)) return 0
  return value.filter((item) => {
    if (!item || typeof item !== 'object') return false
    return (item as { resolution?: unknown }).resolution === 'needs-human'
  }).length
}

function isTaskRequiringAttention(status: string, progressStatus?: string | null, errorLog?: string | null) {
  if (['blocked', 'failed'].includes(status)) return true
  const text = `${progressStatus ?? ''}\n${errorLog ?? ''}`.toLowerCase()
  return /确认|审批|复核|冲突|review|approval|approve|human/.test(text)
}

function countBy<T>(items: T[], keyOf: (item: T) => string) {
  const map = new Map<string, number>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

async function readSavedAgentLibrary(): Promise<SavedAgentLibrary> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, AGENT_LIBRARY_SETTING_KEY))
    .limit(1)
  if (!row) return { found: false, agents: [] }
  if (!row.value) return { found: true, agents: [] }
  try {
    const parsed = JSON.parse(row.value)
    const rawAgents: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : []
    return {
      found: true,
      agents: rawAgents.map(normalizeSavedAgent).filter((agent): agent is SavedAgentConfig => Boolean(agent)),
    }
  } catch {
    return { found: true, agents: [] }
  }
}

async function readMobileUserProfile(userId: string): Promise<MobileUserProfile> {
  const [[userRow], [settingsRow]] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db.select().from(settings).where(eq(settings.key, 'APP_SETTINGS')).limit(1),
  ])
  const settingsProfile = parseAccountProfile(settingsRow?.value)
  return {
    id: userId,
    name: settingsProfile.name || userRow?.username || 'You',
    avatar: settingsProfile.avatar || userRow?.avatarUrl || null,
  }
}

function parseAccountProfile(value?: string | null) {
  if (!value) return { name: '', avatar: '' }
  try {
    const parsed = JSON.parse(value) as { accountName?: unknown; accountAvatar?: unknown }
    return {
      name: typeof parsed.accountName === 'string' ? parsed.accountName.trim() : '',
      avatar: typeof parsed.accountAvatar === 'string' ? parsed.accountAvatar.trim() : '',
    }
  } catch {
    return { name: '', avatar: '' }
  }
}

function normalizeSavedAgent(value: unknown): SavedAgentConfig | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SavedAgentConfig>
  const name = input.name?.trim()
  const role = input.role?.trim()
  if (!name || !role) return null
  const runtimeType = normalizeRuntimeType(input.runtimeType)
  const codeAgentType = runtimeType === 'code-agent' ? normalizeCodeAgentType(input.codeAgentType) : null
  return {
    id: input.id?.trim() || `${name}:${role}`,
    name,
    role,
    roleType: normalizeRoleType(input.roleType),
    description: input.description?.trim() ?? '',
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt?.trim() ?? '',
    roleProfile: input.roleProfile ?? null,
    color: input.color || '#111827',
    modelId: input.modelId ?? null,
    runtimeType,
    codeAgentType,
    capabilityTags: Array.isArray(input.capabilityTags) ? input.capabilityTags.filter(isNonEmptyString) : [],
    toolPermissions: Array.isArray(input.toolPermissions) ? input.toolPermissions.filter(isNonEmptyString) : [],
    sandboxPolicy: normalizeSandboxPolicy(input.sandboxPolicy),
    contextPolicy: normalizeContextPolicy(input.contextPolicy),
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (input.approvalRequired ?? true),
  }
}

function contactsFromSavedAgents(agentList: SavedAgentConfig[]) {
  const seen = new Set<string>()
  return agentList.flatMap((agent) => {
    const key = contactDedupeKey(agent)
    if (seen.has(key)) return []
    seen.add(key)
    return [{
      id: agent.id,
      source: 'library',
      workspaceId: null,
      workspaceAgentId: null,
      name: agent.name,
      role: agent.role,
      roleType: agent.roleType ?? 'custom',
      description: agent.description ?? '',
      avatar: agent.avatar ?? null,
      color: agent.color ?? '#111827',
      runtimeType: agent.runtimeType ?? 'code-agent',
      codeAgentType: agent.codeAgentType ?? null,
      capabilityTags: agent.capabilityTags ?? [],
    }]
  })
}

function contactsFromWorkspaceAgents(agentList: Array<typeof workspaceAgents.$inferSelect>) {
  const seen = new Set<string>()
  return agentList.flatMap((agent) => {
    const key = contactDedupeKey(agent)
    if (seen.has(key)) return []
    seen.add(key)
    return [{
      id: agent.id,
      source: 'workspace-agent',
      workspaceId: agent.workspaceId,
      workspaceAgentId: agent.id,
      name: agent.name,
      role: agent.role,
      roleType: agent.roleType,
      description: agent.description,
      avatar: agent.avatar,
      color: agent.color,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.codeAgentType,
      capabilityTags: agent.capabilityTags,
    }]
  })
}

type MobileAgentContact =
  | ReturnType<typeof contactsFromSavedAgents>[number]
  | ReturnType<typeof contactsFromWorkspaceAgents>[number]

export function mergeMobileContacts(...groups: MobileAgentContact[][]) {
  const byIdentity = new Map<string, MobileAgentContact>()
  for (const group of groups) {
    for (const contact of group) {
      const key = contactDedupeKey(contact)
      const previous = byIdentity.get(key)
      if (!previous || shouldPreferContact(contact, previous)) {
        byIdentity.set(key, contact)
      }
    }
  }
  return [...byIdentity.values()]
}

function shouldPreferContact(candidate: MobileAgentContact, current: MobileAgentContact) {
  const candidateMaterialized = Boolean(candidate.workspaceId && candidate.workspaceAgentId)
  const currentMaterialized = Boolean(current.workspaceId && current.workspaceAgentId)
  if (candidateMaterialized !== currentMaterialized) return candidateMaterialized
  if (candidate.source === 'workspace-agent' && current.source !== 'workspace-agent') return true
  return false
}

function resolveMobileContactAgents(
  requestedAgentIds: string[],
  savedAgents: SavedAgentConfig[],
  agentList: Array<typeof workspaceAgents.$inferSelect>,
) {
  const savedById = new Map(savedAgents.map((agent) => [agent.id, agent]))
  const workspaceById = new Map(agentList.map((agent) => [agent.id, workspaceAgentToSavedAgent(agent)]))
  return requestedAgentIds.flatMap((id) => {
    const saved = savedById.get(id)
    if (saved) return [saved]
    const workspaceAgent = workspaceById.get(id)
    return workspaceAgent ? [workspaceAgent] : []
  })
}

function workspaceAgentToSavedAgent(agent: typeof workspaceAgents.$inferSelect): SavedAgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    roleType: normalizeRoleType(agent.roleType),
    description: agent.description,
    avatar: agent.avatar,
    systemPrompt: agent.systemPrompt,
    roleProfile: agent.roleProfile as Record<string, unknown> | null,
    color: agent.color,
    modelId: agent.modelId,
    runtimeType: normalizeRuntimeType(agent.runtimeType),
    codeAgentType: normalizeCodeAgentType(agent.codeAgentType),
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: normalizeSandboxPolicy(agent.sandboxPolicy),
    contextPolicy: normalizeContextPolicy(agent.contextPolicy),
    autoInvoke: agent.autoInvoke,
    approvalRequired: agent.approvalRequired,
  }
}

export function defaultMobileGroupTitle(agents: SavedAgentConfig[]) {
  const names = agents.slice(0, 3).map((agent) => agent.name).join('、')
  return agents.length > 3 ? `${names} 等 ${agents.length} 个 Agent` : names || 'Agent 群聊'
}

async function ensureSavedAgentDirectSession(ownerId: string, agent: SavedAgentConfig) {
  const sessionList = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.ownerId, ownerId), eq(sessions.type, 'direct')))
    .orderBy(desc(sessions.updatedAt))
  const existingBySavedId = sessionList.find((session) => {
    const metadata = session.metadata ?? {}
    return metadata.kind === 'agent-direct' && metadata.savedAgentId === agent.id
  })
  const workspaceName = (agent.name.trim() || 'Agent').slice(0, 80)
  let workspace: typeof workspaces.$inferSelect | undefined
  if (existingBySavedId?.workspaceId) {
    ;[workspace] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, existingBySavedId.workspaceId), eq(workspaces.ownerId, ownerId)))
      .limit(1)
  }
  if (!workspace) {
    workspace = (await db
      .insert(workspaces)
      .values({
        ownerId,
        name: workspaceName,
        goal: `与 ${agent.name} 单聊`,
        projectPath: null,
      })
      .returning())[0]
  }
  if (!workspace) throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '工作区创建失败')
  if (workspace.name !== workspaceName) {
    const [renamed] = await db
      .update(workspaces)
      .set({ name: workspaceName, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id))
      .returning()
    workspace = renamed ?? workspace
  }

  const workspaceAgentList = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspace.id))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const preferredAgent = existingBySavedId?.workspaceAgentId
    ? workspaceAgentList.find((item) => item.id === existingBySavedId.workspaceAgentId)
    : null
  let workspaceAgent = preferredAgent ?? null
  const agentValues = savedAgentWorkspaceValues(agent)
  if (workspaceAgent) {
    const [updatedAgent] = await db
      .update(workspaceAgents)
      .set(agentValues)
      .where(and(eq(workspaceAgents.id, workspaceAgent.id), eq(workspaceAgents.workspaceId, workspace.id)))
      .returning()
    workspaceAgent = updatedAgent ?? workspaceAgent
  } else {
    const [createdAgent] = await db
      .insert(workspaceAgents)
      .values({
        ...agentValues,
        workspaceId: workspace.id,
        orderIdx: workspaceAgentList.length,
      })
      .returning()
    workspaceAgent = createdAgent ?? null
  }
  if (!workspaceAgent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 创建失败')

  const reusableSession = existingBySavedId ?? null
  const metadata = { ...(reusableSession?.metadata ?? {}), kind: 'agent-direct', savedAgentId: agent.id }
  if (reusableSession) {
    const [updated] = await db
      .update(sessions)
      .set({
        title: agent.name,
        workspaceId: workspace.id,
        workspaceAgentId: workspaceAgent.id,
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, reusableSession.id))
      .returning()
    if (updated) return updated
  }

  const [created] = await db
    .insert(sessions)
    .values({
      title: agent.name,
      type: 'direct',
      ownerId,
      workspaceId: workspace.id,
      workspaceAgentId: workspaceAgent.id,
      metadata,
    })
    .returning()
  if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '会话创建失败')
  return created
}

function savedAgentWorkspaceValues(agent: SavedAgentConfig) {
  const runtimeType = normalizeRuntimeType(agent.runtimeType)
  return {
    name: agent.name,
    role: agent.role,
    roleType: normalizeRoleType(agent.roleType),
    description: agent.description ?? '',
    avatar: agent.avatar ?? null,
    systemPrompt: agent.systemPrompt ?? '',
    roleProfile: agent.roleProfile ?? null,
    color: agent.color ?? '#111827',
    modelId: agent.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? normalizeCodeAgentType(agent.codeAgentType) : null,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: normalizeSandboxPolicy(agent.sandboxPolicy),
    contextPolicy: normalizeContextPolicy(agent.contextPolicy),
    autoInvoke: agent.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (agent.approvalRequired ?? true),
  }
}

function contactDedupeKey(agent: { name: string; role: string; runtimeType?: string | null; codeAgentType?: string | null }) {
  const runtimeType = normalizeText(agent.runtimeType ?? '')
  const codeAgentType = runtimeType === 'code-agent' ? normalizeText(agent.codeAgentType ?? '') : ''
  return [
    normalizeText(agent.name),
    normalizeText(agent.role),
    runtimeType,
    codeAgentType,
  ].join('|')
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) return []
    seen.add(trimmed)
    return [trimmed]
  })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeRoleType(value?: string | null) {
  const allowed = ['orchestrator', 'clarifier', 'architect', 'researcher', 'coder', 'verifier', 'reviewer', 'integrator', 'custom']
  return allowed.includes(value ?? '') ? value! as any : 'custom'
}

function normalizeRuntimeType(value?: string | null) {
  const allowed = ['llm', 'code-agent', 'mcp', 'a2a']
  return allowed.includes(value ?? '') ? value! as any : 'llm'
}

function normalizeCodeAgentType(value?: string | null): WorkspaceCodeAgentType | null {
  if (value === 'codex' || value === 'claude-code' || value === 'opencode' || value === 'gemini') return value
  return null
}

function normalizeSandboxPolicy(value?: string | null) {
  const allowed = ['workspace-write', 'danger-full-access']
  return allowed.includes(value ?? '') ? value! as any : 'workspace-write'
}

function normalizeContextPolicy(value?: string | null) {
  const allowed = ['recent-only', 'pinned-recent', 'workspace-aware']
  return allowed.includes(value ?? '') ? value! as any : 'workspace-aware'
}

function getServerPort() {
  return getRuntimeServerPort() ?? Number(env.PORT || 8000)
}

function pushMobileEvent(event: { type: string; message: string }) {
  mobileEvents.unshift({ ...event, at: new Date().toISOString() })
  mobileEvents.splice(20)
}

async function mobileConnectivityStatus() {
  const port = getServerPort()
  const addresses = listLanAddresses()
  const baseUrls = addresses.map((address) => `http://${address}:${port}`)
  const [networkProfiles, firewall] = await Promise.all([
    getNetworkProfiles(),
    getFirewallStatus(port),
  ])
  const publicProfiles = networkProfiles.filter((item) => item.networkCategory.toLowerCase() === 'public')
  const activePairings = [...pairings.values()].map((record) => ({
    baseUrl: record.baseUrl,
    baseUrls: record.baseUrls,
    expiresAt: new Date(record.expiresAt).toISOString(),
  }))
  return {
    port,
    localAddresses: addresses,
    baseUrls,
    networkProfiles,
    firewall,
    activePairings,
    recentEvents: mobileEvents,
    message: publicProfiles.length
      ? '当前网络为 Public，Windows 可能阻止手机热点入站连接。建议开放 AgentHub 端口，或将该网络改为专用网络。'
      : firewall.allowed
        ? '局域网连接配置看起来正常。'
        : '未检测到 AgentHub 入站防火墙规则，手机可能无法连接。',
  }
}

async function getNetworkProfiles() {
  if (process.platform !== 'win32') return [] as Array<{ name: string; interfaceAlias: string; networkCategory: string; ipv4Connectivity: string }>
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory,IPv4Connectivity | ConvertTo-Json -Compress',
      ],
      { timeout: 3000, windowsHide: true },
    )
    return normalizeNetworkProfiles(JSON.parse(stdout || '[]'))
  } catch {
    return []
  }
}

function normalizeNetworkProfiles(value: any) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => ({
    name: String(item.Name ?? ''),
    interfaceAlias: String(item.InterfaceAlias ?? ''),
    networkCategory: String(item.NetworkCategory ?? ''),
    ipv4Connectivity: String(item.IPv4Connectivity ?? ''),
  }))
}

async function getFirewallStatus(port: number) {
  const ruleName = firewallRuleName(port)
  if (process.platform !== 'win32') {
    return { ruleName, allowed: true, supported: false, rules: [], message: '当前系统不是 Windows，无需使用 Windows 防火墙修复。' }
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          `$rules = Get-NetFirewallRule -DisplayName ${quotePowerShellString(ruleName)} -ErrorAction SilentlyContinue |`,
          'Select-Object DisplayName,Enabled,Direction,Action,Profile;',
          'if ($rules) { $rules | ConvertTo-Json -Compress } else { "[]" }',
        ].join(' '),
      ],
      { timeout: 3000, windowsHide: true },
    )
    const rules = normalizeFirewallRules(JSON.parse(stdout || '[]'))
    const allowed = rules.some((rule) => rule.enabled && rule.direction === 'Inbound' && rule.action === 'Allow')
    return {
      ruleName,
      allowed,
      supported: true,
      rules,
      message: allowed ? `已放行 ${port} 端口。` : `未检测到 ${ruleName} 防火墙放行规则。`,
    }
  } catch (error: any) {
    return { ruleName, allowed: false, supported: true, rules: [], message: error?.message || '读取 Windows 防火墙状态失败。' }
  }
}

function normalizeFirewallRules(value: any) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => ({
    displayName: String(item.DisplayName ?? ''),
    enabled: String(item.Enabled ?? '').toLowerCase() === 'true',
    direction: String(item.Direction ?? ''),
    action: String(item.Action ?? ''),
    profile: String(item.Profile ?? ''),
  }))
}

async function openFirewallPort(port: number) {
  const ruleName = firewallRuleName(port)
  if (process.platform !== 'win32') {
    return { ok: true, message: '当前系统不是 Windows，无需开放 Windows 防火墙端口。' }
  }
  const script = [
    `$name = ${quotePowerShellString(ruleName)};`,
    `$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue;`,
    'if ($existing) {',
    '  Set-NetFirewallRule -DisplayName $name -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null;',
    '} else {',
    `  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null;`,
    '}',
  ].join(' ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 8000, windowsHide: true })
    return { ok: true, message: `已尝试开放 Windows 防火墙 TCP ${port} 入站端口。` }
  } catch (error: any) {
    const elevated = await openFirewallPortElevated(port)
    if (elevated.ok) return elevated
    return {
      ok: false,
      message: [
        `自动开放 TCP ${port} 端口失败，可能需要以管理员身份运行。`,
        `管理员 PowerShell 可执行：New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any`,
        error?.message ? `错误：${error.message}` : '',
      ].filter(Boolean).join('\n'),
    }
  }
}

async function openFirewallPortElevated(port: number) {
  const ruleName = firewallRuleName(port)
  const elevatedScript = [
    `$name = ${quotePowerShellString(ruleName)};`,
    `$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue;`,
    'if ($existing) {',
    '  Set-NetFirewallRule -DisplayName $name -Enabled True -Direction Inbound -Action Allow -Profile Any | Out-Null;',
    '} else {',
    `  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null;`,
    '}',
  ].join(' ')
  const encoded = Buffer.from(elevatedScript, 'utf16le').toString('base64')
  const launcherScript = [
    `$encoded = ${quotePowerShellString(encoded)};`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -Verb RunAs -Wait;",
  ].join(' ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', launcherScript], { timeout: 90_000, windowsHide: true })
    const status = await getFirewallStatus(port)
    return {
      ok: status.allowed,
      message: status.allowed
        ? `已通过管理员权限开放 Windows 防火墙 TCP ${port} 入站端口。`
        : `已请求管理员权限，但没有检测到 ${ruleName} 规则；可能是 UAC 被取消。`,
    }
  } catch (error: any) {
    return {
      ok: false,
      message: [
        `请求管理员权限开放 TCP ${port} 端口失败。`,
        `请手动以管理员身份运行 PowerShell：New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any`,
        error?.message ? `错误：${error.message}` : '',
      ].filter(Boolean).join('\n'),
    }
  }
}

function firewallRuleName(port: number) {
  return `AgentHub Server ${port}`
}

function quotePowerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function createPairingCode() {
  return randomBytes(6).toString('base64url')
}

function cleanupExpiredPairings() {
  const now = Date.now()
  for (const [code, record] of pairings) {
    if (record.expiresAt <= now) pairings.delete(code)
  }
}

function uniqueHosts(hosts: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const host of hosts) {
    const normalized = normalizeHost(host)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function normalizeHost(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

function requestOrigin(request: Request) {
  const url = new URL(request.url)
  const host = request.headers.get('host') || url.host
  if (!host) return ''
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(/:$/, '') || 'http'
  return `${proto}://${host}`
}

function isAllowedPairingBaseUrl(value: string, allowed: string[]) {
  const normalized = value.replace(/\/+$/, '').toLowerCase()
  return allowed.some((item) => item.replace(/\/+$/, '').toLowerCase() === normalized)
}

function sameHost(left: string, right: string) {
  try {
    return new URL(left).hostname === new URL(right).hostname
  } catch {
    return false
  }
}

async function pickLanAddress() {
  const addresses = listLanAddresses()
  const defaultRouteAddress = await getDefaultRouteAddress()
  if (defaultRouteAddress && addresses.includes(defaultRouteAddress)) return defaultRouteAddress
  return addresses[0] ?? defaultRouteAddress ?? '127.0.0.1'
}

function listLanAddresses() {
  const candidates: Array<{ address: string; alias: string; score: number }> = []
  for (const [alias, items] of Object.entries(networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const score = scoreNetworkAddress(alias, item.address)
      if (score < 0) continue
      candidates.push({ address: item.address, alias, score })
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.alias.localeCompare(b.alias))
    .map((item) => item.address)
}

async function getDefaultRouteAddress() {
  if (process.platform !== 'win32') return undefined
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '$route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" |',
          'Where-Object { $_.NextHop -ne "0.0.0.0" } |',
          'Sort-Object RouteMetric,InterfaceMetric |',
          'Select-Object -First 1;',
          'if ($route) {',
          'Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |',
          'Where-Object { $_.IPAddress -notlike "169.254.*" } |',
          'Select-Object -First 1 -ExpandProperty IPAddress',
          '}',
        ].join(' '),
      ],
      { timeout: 2000, windowsHide: true },
    )
    const address = stdout.trim()
    if (address && scoreNetworkAddress('', address) >= 0) return address
  } catch {
    // PowerShell route probing is best-effort; fall back to Node networkInterfaces.
  }
  return undefined
}

function scoreNetworkAddress(alias: string, address: string) {
  if (address.startsWith('169.254.')) return -1
  if (/(virtual|vmware|virtualbox|hyper-v|vethernet|wsl|tap|radmin|loopback|docker)/i.test(alias)) {
    return -1
  }
  if (address.startsWith('192.168.56.') || address.startsWith('192.168.110.') || address.startsWith('192.168.190.')) return -1
  if (/^(wlan|wi-fi|wifi|无线|以太网|ethernet)/i.test(alias)) return 100
  if (address.startsWith('192.168.') || address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 50
  return 10
}
