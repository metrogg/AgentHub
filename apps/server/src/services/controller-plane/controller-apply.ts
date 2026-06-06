import { controllerAuditEvents, db, eq, timelineEvents } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { ensureManagerParticipantForRoom } from '../rooms/manager-participant'
import { roomService } from '../rooms/room-service'
import type { ControllerApi } from './controller-api'
import {
  CONTROLLER_ROOM_KINDS,
  CONTROLLER_WORKER_RUNTIME_BASES,
  getControllerApiSchema,
  type ControllerApiOperationSchema,
} from './controller-api-schema'
import { normalizeWorkerRuntimeBase } from './worker-runtime-base'

export interface ControllerApplyBody {
  yaml?: string
  json?: string
  resource?: unknown
  resources?: unknown[]
  approval?: {
    approved?: boolean
    reason?: string
    approvedBy?: string
  }
  approvalToken?: string
  approvalMode?: 'apply' | 'request'
  requestApprovalRoomId?: string
  approvalRequest?: {
    roomId?: string
    reason?: string
    requestedBy?: string
  }
}

export interface ControllerApplyResult {
  success: boolean
  approvalRequested?: boolean
  approvalEventId?: string | null
  applied: Array<{
    kind: string
    name?: string | null
    approval: {
      level: ControllerApiOperationSchema['approval']
      required: boolean
      provided: boolean
      approvedBy: string | null
      reason: string | null
    }
    auditEventId: string | null
    audit: {
      operationId: string
      applyOperationId: 'apply.manifest'
      danger: ControllerApiOperationSchema['danger']
      manifestKind: string
      manifestName: string | null
      fields: Record<string, unknown>
    }
    result: unknown
  }>
}

export async function applyControllerManifest(
  api: ControllerApi,
  body: ControllerApplyBody,
): Promise<ControllerApplyResult> {
  const resources = parseApplyResources(body)
  if (body.approvalMode === 'request') {
    return requestControllerApplyApproval(body, resources)
  }
  const applied = []
  for (const resource of resources) {
    const manifest = normalizeManifest(resource)
    const operation = operationForManifestKind(manifest.kind)
    const approval = approvalSnapshot(operation, body)
    if (approval.required && !approval.provided) {
      throw AppError.fromCode(
        AppErrorCodes.FORBIDDEN,
        `Controller apply ${manifest.kind} requires approval for operation ${operation.id}.`,
      )
    }
    const result = await applyOne(api, manifest)
    const audit = auditSnapshot(operation, manifest)
    const auditEventId = await persistControllerAuditEvent({
      audit,
      approval,
      result,
    })
    applied.push({
      kind: manifest.kind,
      name: manifest.metadata.name ?? null,
      approval,
      auditEventId,
      audit,
      result,
    })
  }
  return { success: true, applied }
}

export async function confirmControllerApplyApproval(
  api: ControllerApi,
  input: {
    approvalEventId: string
    approvedBy?: string | null
    reason?: string | null
  },
): Promise<ControllerApplyResult & { approvalEventId: string }> {
  const [event] = await db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.id, input.approvalEventId))
    .limit(1)
  if (!event) {
    throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Controller approval request event not found.')
  }
  const metadata = objectValue(event.metadata)
  if (metadata.kind !== 'controller.apply.approval.requested') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Timeline event is not a Controller apply approval request.')
  }
  if (metadata.status === 'approved') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller apply approval request has already been approved.')
  }
  if (metadata.status === 'denied') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller apply approval request has already been denied.')
  }
  const resources = Array.isArray(metadata.resources) ? metadata.resources : []
  if (!resources.length) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller approval request does not contain apply resources.')
  }
  const result = await applyControllerManifest(api, {
    resources,
    approval: {
      approved: true,
      approvedBy: input.approvedBy ?? 'human',
      reason: input.reason ?? stringValue(metadata.reason) ?? 'Approved from Room timeline.',
    },
  })
  await markControllerApprovalEventResolved(event.id, event.metadata, {
    status: 'approved',
    resolvedBy: input.approvedBy ?? 'human',
    reason: input.reason ?? null,
    appliedCount: result.applied.length,
    auditEventIds: result.applied.map((item) => item.auditEventId).filter(Boolean),
  })
  await appendControllerApprovalStatusEvent({
    roomId: event.roomId,
    approvalEventId: event.id,
    status: 'approved',
    approvedBy: input.approvedBy ?? 'human',
    reason: input.reason ?? null,
    result,
  })
  return {
    ...result,
    approvalEventId: event.id,
  }
}

export async function denyControllerApplyApproval(input: {
  approvalEventId: string
  deniedBy?: string | null
  reason?: string | null
}): Promise<{ success: true; approvalEventId: string; status: 'denied' }> {
  const [event] = await db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.id, input.approvalEventId))
    .limit(1)
  if (!event) {
    throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Controller approval request event not found.')
  }
  const metadata = objectValue(event.metadata)
  if (metadata.kind !== 'controller.apply.approval.requested') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Timeline event is not a Controller apply approval request.')
  }
  if (metadata.status === 'approved' || metadata.status === 'denied') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply approval request has already been ${metadata.status}.`)
  }
  await markControllerApprovalEventResolved(event.id, event.metadata, {
    status: 'denied',
    resolvedBy: input.deniedBy ?? 'human',
    reason: input.reason ?? null,
  })
  await appendControllerApprovalStatusEvent({
    roomId: event.roomId,
    approvalEventId: event.id,
    status: 'denied',
    approvedBy: input.deniedBy ?? 'human',
    reason: input.reason ?? null,
    result: null,
  })
  return { success: true, approvalEventId: event.id, status: 'denied' }
}

async function markControllerApprovalEventResolved(
  eventId: string,
  metadata: Record<string, unknown>,
  resolution: Record<string, unknown> & { status: 'approved' | 'denied' },
) {
  await db
    .update(timelineEvents)
    .set({
      metadata: {
        ...metadata,
        status: resolution.status,
        resolution,
        resolvedAt: new Date().toISOString(),
      },
    })
    .where(eq(timelineEvents.id, eventId))
}

async function requestControllerApplyApproval(
  body: ControllerApplyBody,
  resources: unknown[],
): Promise<ControllerApplyResult> {
  const roomId = body.requestApprovalRoomId ?? body.approvalRequest?.roomId
  if (!roomId) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'approvalMode=request requires requestApprovalRoomId or approvalRequest.roomId.')
  }
  const manifests = resources.map(normalizeManifest)
  const operations = manifests.map((manifest) => operationForManifestKind(manifest.kind))
  const manager = await ensureManagerParticipantForRoom(roomId)
  const summary = manifests.map((manifest, index) => {
    const operation = operations[index]!
    return {
      kind: manifest.kind,
      name: manifest.metadata.name ?? null,
      operationId: operation.id,
      danger: operation.danger,
      approval: operation.approval,
      audit: auditSnapshot(operation, manifest),
    }
  })
  const event = await roomService.appendTimelineEvent({
    roomId,
    senderParticipantId: manager.id,
    senderType: 'manager',
    type: 'approval.requested',
    body: approvalRequestBody(summary, body.approvalRequest?.reason),
    metadata: {
      kind: 'controller.apply.approval.requested',
      actionType: 'controller_apply',
      status: 'pending',
      resources,
      summary,
      reason: body.approvalRequest?.reason ?? null,
      requestedBy: body.approvalRequest?.requestedBy ?? null,
      skipAutoDispatch: true,
    },
  })
  return {
    success: true,
    approvalRequested: true,
    approvalEventId: event.id,
    applied: [],
  }
}

async function appendControllerApprovalStatusEvent(input: {
  roomId: string
  approvalEventId: string
  status: 'approved' | 'denied'
  approvedBy: string | null
  reason: string | null
  result: unknown
}) {
  const manager = await ensureManagerParticipantForRoom(input.roomId)
  await roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderParticipantId: manager.id,
    senderType: 'manager',
    type: 'manager.message',
    body: input.status === 'approved'
      ? '已确认 Controller 变更，正在按审批结果执行。'
      : '已拒绝 Controller 变更，本次申请不会执行。',
    metadata: {
      kind: 'controller.apply.approval.resolved',
      approvalEventId: input.approvalEventId,
      status: input.status,
      resolvedBy: input.approvedBy,
      reason: input.reason,
      result: input.result,
      skipAutoDispatch: true,
    },
  })
}

function approvalRequestBody(
  summary: Array<{ kind: string; name: string | null; operationId: string; danger: string; approval: string }>,
  reason?: string | null,
) {
  const lines = [
    '需要确认 Controller 变更：',
    ...summary.map((item) => `- ${item.kind}${item.name ? ` ${item.name}` : ''}: ${item.operationId}, danger=${item.danger}, approval=${item.approval}`),
  ]
  if (reason) lines.push(`原因：${reason}`)
  return lines.join('\n')
}

interface NormalizedManifest {
  apiVersion: string | null
  kind: string
  metadata: Record<string, unknown> & { name?: string }
  spec: Record<string, unknown>
}

function parseApplyResources(body: ControllerApplyBody): unknown[] {
  if (Array.isArray(body.resources)) return body.resources
  if (body.resource) return [body.resource]
  if (typeof body.json === 'string' && body.json.trim()) {
    const parsed = JSON.parse(body.json)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  if (typeof body.yaml === 'string' && body.yaml.trim()) {
    const documents = body.yaml
      .split(/^---\s*$/m)
      .map((item) => item.trim())
      .filter(Boolean)
      .map(parseSimpleYamlDocument)
    return documents
  }
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller apply requires yaml, json, resource, or resources.')
}

function normalizeManifest(value: unknown): NormalizedManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller apply resource must be an object.')
  }
  const record = value as Record<string, unknown>
  const kind = stringValue(record.kind)
  if (!kind) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller apply resource.kind is required.')
  const metadata = objectValue(record.metadata)
  const spec = objectValue(record.spec)
  return {
    apiVersion: stringValue(record.apiVersion),
    kind,
    metadata: { ...metadata, name: stringValue(metadata.name) ?? stringValue(record.name) ?? undefined },
    spec,
  }
}

async function applyOne(api: ControllerApi, manifest: NormalizedManifest) {
  switch (manifest.kind) {
    case 'Worker':
      return applyWorkerManifest(api, manifest)
    case 'Manager':
      return applyManagerManifest(api, manifest)
    case 'Room':
      return applyRoomManifest(api, manifest)
    case 'Task':
      return applyTaskManifest(api, manifest)
    case 'Team':
      return applyTeamManifest(api, manifest)
    case 'Human':
      return applyHumanManifest(api, manifest)
    default:
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply does not support kind ${manifest.kind} yet.`)
  }
}

function operationForManifestKind(kind: string): ControllerApiOperationSchema {
  const operationId = ({
    Worker: 'workers.create',
    Manager: 'managers.reconcile',
    Room: 'rooms.create',
    Task: 'tasks.assign',
    Team: 'teams.create',
    Human: 'humans.create',
  } as Record<string, string>)[kind] ?? 'apply.manifest'
  const operation = getControllerApiSchema().operations.find((item) => item.id === operationId)
    ?? getControllerApiSchema().operations.find((item) => item.id === 'apply.manifest')
  if (!operation) {
    throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, `Controller schema is missing operation ${operationId}.`)
  }
  return operation
}

function approvalSnapshot(operation: ControllerApiOperationSchema, body: ControllerApplyBody) {
  const tokenProvided = Boolean(stringValue(body.approvalToken))
  const approved = Boolean(body.approval?.approved) || tokenProvided
  return {
    level: operation.approval,
    required: operation.approval === 'required',
    provided: approved,
    approvedBy: stringValue(body.approval?.approvedBy) ?? null,
    reason: stringValue(body.approval?.reason) ?? null,
  }
}

function auditSnapshot(operation: ControllerApiOperationSchema, manifest: NormalizedManifest) {
  return {
    operationId: operation.id,
    applyOperationId: 'apply.manifest' as const,
    danger: operation.danger,
    manifestKind: manifest.kind,
    manifestName: manifest.metadata.name ?? null,
    fields: Object.fromEntries(operation.audit.map((path) => [
      path,
      readAuditField(path, manifest, operation.id === 'apply.manifest'),
    ])),
  }
}

async function persistControllerAuditEvent(input: {
  audit: ControllerApplyResult['applied'][number]['audit']
  approval: ControllerApplyResult['applied'][number]['approval']
  result: unknown
}): Promise<string | null> {
  const summary = summarizeApplyResult(input.result, input.audit.manifestKind)
  const workspaceId = stringValue(input.audit.fields.workspaceId)
  const [row] = await db
    .insert(controllerAuditEvents)
    .values({
      operationId: input.audit.operationId,
      applyOperationId: input.audit.applyOperationId,
      danger: input.audit.danger,
      approvalLevel: input.approval.level,
      approvalRequired: input.approval.required,
      approvalProvided: input.approval.provided,
      approvedBy: input.approval.approvedBy,
      approvalReason: input.approval.reason,
      manifestKind: input.audit.manifestKind,
      manifestName: input.audit.manifestName,
      workspaceId,
      resourceId: stringValue(summary.resourceId),
      resourceKind: input.audit.manifestKind,
      auditFields: input.audit.fields,
      resultSummary: summary,
    })
    .returning({ id: controllerAuditEvents.id })
  return row?.id ?? null
}

function summarizeApplyResult(result: unknown, manifestKind: string): Record<string, unknown> {
  const record = objectValue(result)
  const room = objectValue(record.room)
  const human = objectValue(record.human)
  const resourceId =
    stringValue(record.id) ??
    stringValue(record.workerInstanceId) ??
    stringValue(record.agentId) ??
    stringValue(record.teamId) ??
    stringValue(room.id) ??
    stringValue(human.id)
  return {
    resourceId,
    resourceKind: manifestKind,
    id: stringValue(record.id),
    status: stringValue(record.status),
    phase: stringValue(record.phase),
    workerInstanceId: stringValue(record.workerInstanceId),
    agentId: stringValue(record.agentId),
    roomId: stringValue(room.id),
    humanId: stringValue(human.id),
  }
}

function readAuditField(path: string, manifest: NormalizedManifest, manifestKindContext: boolean): unknown {
  if (path === 'kind' && manifestKindContext) return manifest.kind
  if (path === 'kind') return manifest.spec.kind ?? manifest.metadata.kind ?? null
  const root = manifest as unknown as Record<string, unknown>
  const direct = readObjectPath(root, path)
  if (direct != null) return direct
  const fromSpec = readObjectPath(manifest.spec, path)
  if (fromSpec != null) return fromSpec
  const fromMetadata = readObjectPath(manifest.metadata, path)
  return fromMetadata ?? null
}

function readObjectPath(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
    return (current as Record<string, unknown>)[part] ?? null
  }, root)
}

function applyManagerManifest(api: ControllerApi, manifest: NormalizedManifest) {
  const runtimeType = stringValue(manifest.spec.runtimeType) ?? 'openclaw'
  if (runtimeType !== 'openclaw' && runtimeType !== 'qwenpaw') {
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      'Controller apply Manager requires spec.runtimeType to be openclaw or qwenpaw.',
    )
  }
  const desiredState = stringValue(manifest.spec.desiredState)
  if (
    desiredState &&
    !['running', 'started', 'listening', 'ready', 'stopped', 'stopping', 'sleeping', 'observed', 'observe', 'status', 'health'].includes(desiredState.trim().toLowerCase())
  ) {
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      'Controller apply Manager requires spec.desiredState to be running, stopped, or observed when provided.',
    )
  }
  return api.reconcileManager({
    managerId: stringValue(manifest.metadata.name ?? manifest.spec.managerId) ?? 'global',
    runtimeType,
    desiredState,
    controllerUrl: stringValue(manifest.spec.controllerUrl),
    sharedStorageRoot: stringValue(manifest.spec.sharedStorageRoot),
    matrixHomeserverUrl: stringValue(manifest.spec.matrixHomeserverUrl),
    matrixServerName: stringValue(manifest.spec.matrixServerName),
    reason: 'controller-apply-manager',
  })
}

function applyWorkerManifest(api: ControllerApi, manifest: NormalizedManifest) {
  const runtimeBase = normalizeWorkerRuntimeBase(
    stringValue(manifest.spec.runtimeBase) ??
      stringValue(manifest.spec.workerRuntimeBase) ??
      stringValue(manifest.spec.codeAgentType),
  )
  if (!runtimeBase) {
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      `Controller apply Worker requires spec.runtimeBase to be one of ${CONTROLLER_WORKER_RUNTIME_BASES.join(', ')}.`,
    )
  }
  const modelId = requiredString(manifest.spec.modelId, 'spec.modelId')
  const skillIds = optionalStringArray(manifest.spec.skillIds, 'spec.skillIds')
  const roleProfile = optionalObject(manifest.spec.roleProfile, 'spec.roleProfile')
  const sandboxPolicy = sandboxPolicyValue(manifest.spec.sandboxPolicy)

  return api.createWorker({
    workspaceId: requiredString(manifest.spec.workspaceId, 'spec.workspaceId'),
    name: requiredString(manifest.metadata.name ?? manifest.spec.name, 'metadata.name'),
    runtimeBase,
    workerRuntimeBase: stringValue(manifest.spec.workerRuntimeBase) ?? undefined,
    codeAgentType: stringValue(manifest.spec.codeAgentType) ?? undefined,
    modelId,
    skillIds,
    role: stringValue(manifest.spec.role) ?? undefined,
    roleType: stringValue(manifest.spec.roleType) ?? undefined,
    description: stringValue(manifest.spec.description) ?? undefined,
    systemPrompt: stringValue(manifest.spec.systemPrompt) ?? undefined,
    roleProfile,
    sandboxPolicy,
    ownerId: stringValue(manifest.spec.ownerId) ?? null,
    groupSessionId: stringValue(manifest.spec.groupSessionId) ?? null,
    joinGroupRoom: optionalBoolean(manifest.spec.joinGroupRoom, 'spec.joinGroupRoom') ?? false,
    createDirectSession: optionalBoolean(manifest.spec.createDirectSession, 'spec.createDirectSession') ?? true,
    announce: optionalBoolean(manifest.spec.announce, 'spec.announce') ?? true,
  })
}

function applyRoomManifest(api: ControllerApi, manifest: NormalizedManifest) {
  const kind = optionalRoomKind(manifest.spec.kind)
  return api.createRoom({
    ownerId: requiredString(manifest.spec.ownerId, 'spec.ownerId'),
    title: requiredString(manifest.spec.title ?? manifest.metadata.name, 'spec.title'),
    kind,
    workspaceId: stringValue(manifest.spec.workspaceId) ?? null,
  })
}

function applyTaskManifest(api: ControllerApi, manifest: NormalizedManifest) {
  return api.assignTask({
    workspaceId: requiredString(manifest.spec.workspaceId, 'spec.workspaceId'),
    title: requiredString(manifest.spec.title ?? manifest.metadata.name, 'spec.title'),
    spec:
      stringValue(manifest.spec.spec) ??
      stringValue(manifest.spec.taskSpec) ??
      stringValue(manifest.spec.description) ??
      null,
    targetWorkerId: stringValue(manifest.spec.targetWorkerId) ?? stringValue(manifest.spec.assignToAgentId) ?? null,
    taskKey: stringValue(manifest.spec.taskKey) ?? null,
    dependsOn: optionalStringArray(manifest.spec.dependsOn, 'spec.dependsOn'),
    runId: stringValue(manifest.spec.runId) ?? null,
    groupSessionId: stringValue(manifest.spec.groupSessionId) ?? null,
    ownerId: stringValue(manifest.spec.ownerId) ?? null,
  })
}

function applyTeamManifest(api: ControllerApi, manifest: NormalizedManifest) {
  return api.createTeam({
    workspaceId: requiredString(manifest.spec.workspaceId, 'spec.workspaceId'),
    name: requiredString(manifest.metadata.name ?? manifest.spec.name, 'metadata.name'),
    leaderName: stringValue(manifest.spec.leaderName) ?? undefined,
    leaderModel: stringValue(manifest.spec.leaderModel) ?? undefined,
    workers:
      optionalStringArray(manifest.spec.workers, 'spec.workers') ??
      optionalStringArray(manifest.spec.memberRefs, 'spec.memberRefs'),
    description: stringValue(manifest.spec.description) ?? undefined,
  })
}

function applyHumanManifest(api: ControllerApi, manifest: NormalizedManifest) {
  return api.createHuman({
    name: requiredString(manifest.metadata.name ?? manifest.spec.name, 'metadata.name'),
    displayName: requiredString(manifest.spec.displayName ?? manifest.metadata.name, 'spec.displayName'),
    email: stringValue(manifest.spec.email) ?? undefined,
    permissionLevel: optionalNumber(manifest.spec.permissionLevel, 'spec.permissionLevel'),
  })
}

function parseSimpleYamlDocument(input: string): unknown {
  const lines = input
    .split(/\r?\n/)
    .map((raw) => ({ indent: raw.match(/^\s*/)?.[0].length ?? 0, text: stripYamlComment(raw).trim() }))
    .filter((line) => line.text)
  if (lines.length === 0) return {}
  const [value, next] = parseYamlBlock(lines, 0, lines[0]!.indent)
  if (next < lines.length) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Unable to parse YAML near: ${lines[next]?.text}`)
  }
  return value
}

function parseYamlBlock(
  lines: Array<{ indent: number; text: string }>,
  start: number,
  indent: number,
): [unknown, number] {
  if (lines[start]?.text.startsWith('- ')) {
    const items: unknown[] = []
    let index = start
    while (index < lines.length && lines[index]!.indent === indent && lines[index]!.text.startsWith('- ')) {
      const item = lines[index]!.text.slice(2).trim()
      items.push(parseYamlScalar(item))
      index += 1
    }
    return [items, index]
  }

  const object: Record<string, unknown> = {}
  let index = start
  while (index < lines.length && lines[index]!.indent === indent && !lines[index]!.text.startsWith('- ')) {
    const line = lines[index]!.text
    const splitAt = line.indexOf(':')
    if (splitAt < 0) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Invalid YAML line: ${line}`)
    const key = line.slice(0, splitAt).trim()
    const rest = line.slice(splitAt + 1).trim()
    if (!key) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Invalid YAML key: ${line}`)
    if (rest) {
      object[key] = parseYamlScalar(rest)
      index += 1
      continue
    }
    const next = lines[index + 1]
    if (!next || next.indent <= indent) {
      object[key] = {}
      index += 1
      continue
    }
    const [child, nextIndex] = parseYamlBlock(lines, index + 1, next.indent)
    object[key] = child
    index = nextIndex
  }
  return [object, index]
}

function stripYamlComment(raw: string) {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('#')) return ''
  return raw
}

function parseYamlScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((item) => parseYamlScalar(item.trim()))
  }
  return value
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply requires ${path} to be a string array.`)
  }
  const items = value.map((item, index) => requiredString(item, `${path}[${index}]`))
  return items.length ? items : undefined
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value == null) return undefined
  if (typeof value === 'boolean') return value
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply requires ${path} to be a boolean.`)
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply requires ${path} to be a number.`)
}

function optionalObject(value: unknown, path: string): Record<string, unknown> {
  if (value == null) return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply requires ${path} to be an object.`)
}

function sandboxPolicyValue(value: unknown): string | undefined {
  const direct = stringValue(value)
  if (direct) return direct
  if (value == null) return undefined
  const object = optionalObject(value, 'spec.sandboxPolicy')
  const mode = stringValue(object.mode)
  if (mode) return mode
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Controller apply requires spec.sandboxPolicy.mode when sandboxPolicy is an object.')
}

function optionalRoomKind(value: unknown) {
  const kind = stringValue(value) ?? 'group'
  if (CONTROLLER_ROOM_KINDS.includes(kind)) {
    return kind as 'group' | 'manager_dm' | 'task' | 'direct' | 'human_intervention'
  }
  throw AppError.fromCode(
    AppErrorCodes.VALIDATION_FAILED,
    `Controller apply Room requires spec.kind to be one of ${CONTROLLER_ROOM_KINDS.join(', ')}.`,
  )
}

function requiredString(value: unknown, path: string): string {
  const text = stringValue(value)
  if (!text) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply requires ${path}.`)
  return text
}
