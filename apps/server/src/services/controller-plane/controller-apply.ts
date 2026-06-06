import { AppError, AppErrorCodes } from '../../lib/error'
import type { ControllerApi } from './controller-api'

export interface ControllerApplyBody {
  yaml?: string
  json?: string
  resource?: unknown
  resources?: unknown[]
}

export interface ControllerApplyResult {
  success: boolean
  applied: Array<{
    kind: string
    name?: string | null
    result: unknown
  }>
}

export async function applyControllerManifest(
  api: ControllerApi,
  body: ControllerApplyBody,
): Promise<ControllerApplyResult> {
  const resources = parseApplyResources(body)
  const applied = []
  for (const resource of resources) {
    const manifest = normalizeManifest(resource)
    applied.push({
      kind: manifest.kind,
      name: manifest.metadata.name ?? null,
      result: await applyOne(api, manifest),
    })
  }
  return { success: true, applied }
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
      return api.createWorker({
        workspaceId: requiredString(manifest.spec.workspaceId, 'spec.workspaceId'),
        name: requiredString(manifest.metadata.name ?? manifest.spec.name, 'metadata.name'),
        runtimeBase: stringValue(manifest.spec.runtimeBase) ?? stringValue(manifest.spec.workerRuntimeBase) ?? undefined,
        workerRuntimeBase: stringValue(manifest.spec.workerRuntimeBase) ?? undefined,
        codeAgentType: stringValue(manifest.spec.codeAgentType) ?? undefined,
        modelId: stringValue(manifest.spec.modelId) ?? null,
        skillIds: stringArrayValue(manifest.spec.skillIds),
        role: stringValue(manifest.spec.role) ?? undefined,
        roleType: stringValue(manifest.spec.roleType) ?? undefined,
        description: stringValue(manifest.spec.description) ?? undefined,
        systemPrompt: stringValue(manifest.spec.systemPrompt) ?? undefined,
        roleProfile: objectValue(manifest.spec.roleProfile),
        sandboxPolicy: stringValue(manifest.spec.sandboxPolicy) ?? undefined,
        ownerId: stringValue(manifest.spec.ownerId) ?? null,
        groupSessionId: stringValue(manifest.spec.groupSessionId) ?? null,
        joinGroupRoom: booleanValue(manifest.spec.joinGroupRoom) ?? false,
        createDirectSession: booleanValue(manifest.spec.createDirectSession) ?? true,
        announce: booleanValue(manifest.spec.announce) ?? true,
      })
    case 'Room':
      return api.createRoom({
        ownerId: requiredString(manifest.spec.ownerId, 'spec.ownerId'),
        title: requiredString(manifest.spec.title ?? manifest.metadata.name, 'spec.title'),
        kind: stringValue(manifest.spec.kind) as any,
        workspaceId: stringValue(manifest.spec.workspaceId) ?? null,
      })
    case 'Task':
      return api.assignTask({
        workspaceId: requiredString(manifest.spec.workspaceId, 'spec.workspaceId'),
        title: requiredString(manifest.spec.title ?? manifest.metadata.name, 'spec.title'),
        spec: stringValue(manifest.spec.spec) ?? stringValue(manifest.spec.description) ?? null,
        targetWorkerId: stringValue(manifest.spec.targetWorkerId) ?? stringValue(manifest.spec.assignToAgentId) ?? null,
        taskKey: stringValue(manifest.spec.taskKey) ?? null,
        dependsOn: stringArrayValue(manifest.spec.dependsOn),
        runId: stringValue(manifest.spec.runId) ?? null,
        groupSessionId: stringValue(manifest.spec.groupSessionId) ?? null,
        ownerId: stringValue(manifest.spec.ownerId) ?? null,
      })
    default:
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply does not support kind ${manifest.kind} yet.`)
  }
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

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map(stringValue).filter((item): item is string => Boolean(item))
  return items.length ? items : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function requiredString(value: unknown, path: string): string {
  const text = stringValue(value)
  if (!text) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Controller apply requires ${path}.`)
  return text
}
