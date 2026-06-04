import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface OpenClawAgentSummary {
  id: string
  name: string
  role: string
  workspace: string | null
  agentDir: string | null
  bindings: number
  isDefault: boolean
  routes: string[]
  agentHubDraft: {
    name: string
    role: string
    roleType: 'custom'
    description: string
    systemPrompt: string
    roleProfile: Record<string, unknown>
    color: string
    modelId: null
    runtimeType: 'code-agent'
    codeAgentType: 'openclaw'
    capabilityTags: string[]
    skillIds: string[]
    toolPermissions: string[]
    sandboxPolicy: 'workspace-write'
    contextPolicy: 'workspace-aware'
    autoInvoke: boolean
    approvalRequired: boolean
  }
}

export interface OpenClawAgentsCatalog {
  ok: boolean
  command: string
  installed: boolean
  items: OpenClawAgentSummary[]
  diagnostics?: string
  message: string
}

type RawOpenClawAgent = Record<string, unknown>

const OPENCLAW_AGENT_PROBE_TIMEOUT_MS = 5_000

export async function getOpenClawAgentsCatalog(command = 'openclaw'): Promise<OpenClawAgentsCatalog> {
  const safeCommand = isSafeCommand(command) ? command : 'openclaw'
  const primary = await runOpenClawJson(safeCommand, ['agents', 'list', '--bindings', '--json'])
  const fallback =
    primary.ok ? primary : await runOpenClawJson(safeCommand, ['agents', 'list', '--json'])

  if (!fallback.ok) {
    return {
      ok: false,
      command: safeCommand,
      installed: await isCommandReachable(safeCommand),
      items: [],
      diagnostics: fallback.output,
      message: fallback.output || `Unable to read OpenClaw agents with ${safeCommand}.`,
    }
  }

  const items = normalizeOpenClawAgents(fallback.data)
  return {
    ok: true,
    command: safeCommand,
    installed: true,
    items,
    diagnostics: fallback.output,
    message: items.length
      ? `Detected ${items.length} OpenClaw agent${items.length === 1 ? '' : 's'}.`
      : 'OpenClaw is installed, but no agents were returned.',
  }
}

export function normalizeOpenClawAgents(value: unknown): OpenClawAgentSummary[] {
  const rows = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  return rows
    .map((row) => normalizeOpenClawAgent(row))
    .filter((item): item is OpenClawAgentSummary => Boolean(item))
    .filter((item) => {
      const key = item.id.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function normalizeOpenClawAgent(value: unknown): OpenClawAgentSummary | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as RawOpenClawAgent
  const id = stringValue(raw.id) ?? stringValue(raw.name) ?? stringValue(raw.agentId)
  if (!id) return null

  const identity = raw.identity && typeof raw.identity === 'object'
    ? (raw.identity as Record<string, unknown>)
    : {}
  const name =
    stringValue(identity.name) ??
    stringValue(raw.identityName) ??
    stringValue(raw.displayName) ??
    stringValue(raw.name) ??
    `OpenClaw ${id}`
  const role =
    stringValue(identity.role) ??
    stringValue(raw.role) ??
    (truthy(raw.isDefault) ? 'OpenClaw default agent' : 'OpenClaw local agent')
  const workspace = stringValue(raw.workspace)
  const agentDir = stringValue(raw.agentDir)
  const bindings = numberValue(raw.bindings)
  const routes = stringArray(raw.routes)
  const isDefault = truthy(raw.isDefault)

  return {
    id,
    name,
    role,
    workspace,
    agentDir,
    bindings,
    isDefault,
    routes,
    agentHubDraft: {
      name,
      role,
      roleType: 'custom',
      description: [
        'Imported from local OpenClaw.',
        workspace ? `Workspace: ${workspace}` : '',
        routes.length ? `Routes: ${routes.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      systemPrompt:
        'You are an OpenClaw-backed local agent connected through AgentHub. Use your OpenClaw identity and tools to complete the user task.',
      roleProfile: {
        source: 'openclaw',
        openclawAgentId: id,
        openclawWorkspace: workspace,
        openclawAgentDir: agentDir,
        openclawRoutes: routes,
        openclawDefault: isDefault,
        openclawIdentityName: stringValue(raw.identityName),
        openclawModel: stringValue(raw.model),
      },
      color: '#111827',
      modelId: null,
      runtimeType: 'code-agent',
      codeAgentType: 'openclaw',
      capabilityTags: ['openclaw', isDefault ? 'default-agent' : 'local-agent'].filter(Boolean),
      skillIds: [],
      toolPermissions: ['chat', 'filesystem'],
      sandboxPolicy: 'workspace-write',
      contextPolicy: 'workspace-aware',
      autoInvoke: true,
      approvalRequired: false,
    },
  }
}

async function runOpenClawJson(command: string, args: string[]) {
  const result = await runOpenClawCommand(command, args)
  const parsed = parseOpenClawJsonOutput(result.stdout) ?? parseOpenClawJsonOutput(result.output)
  if (parsed) return { ok: true as const, data: parsed, output: result.output }
  if (result.code !== 0) return { ok: false as const, output: result.output }
  return { ok: false as const, output: result.output || 'OpenClaw returned invalid JSON.' }
}

async function runOpenClawCommand(command: string, args: string[]) {
  try {
    const proc = Bun.spawn(buildHostCommand(command, args), {
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })
    const [code, stdout, stderr] = await Promise.all([
      Promise.race([
        proc.exited,
        new Promise<number>((resolve) => {
          setTimeout(() => {
            try {
              proc.kill()
            } catch {
              // Process may have already exited.
            }
            resolve(124)
          }, OPENCLAW_AGENT_PROBE_TIMEOUT_MS)
        }),
      ]),
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
    ])
    return {
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
    }
  } catch (error: any) {
    const output = error?.message || 'OpenClaw command failed to start.'
    return { code: 127, stdout: '', stderr: output, output }
  }
}

function parseOpenClawJsonOutput(output: string) {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const extracted = extractFirstJsonDocument(trimmed)
    if (!extracted) return null
    try {
      return JSON.parse(extracted)
    } catch {
      return null
    }
  }
}

function extractFirstJsonDocument(value: string) {
  const start = value.search(/[\[{]/)
  if (start < 0) return null
  const open = value[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    if (char === close) {
      depth -= 1
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  return null
}

async function isCommandReachable(command: string) {
  try {
    const proc = Bun.spawn(
      process.platform === 'win32'
        ? [getWindowsCommandShell(), '/d', '/c', `where ${windowsShellArg(command)}`]
        : ['sh', '-lc', `command -v ${quoteForSh(command)}`],
      { stdout: 'ignore', stderr: 'ignore', env: process.env },
    )
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 1_000)),
    ])
    return code === 0
  } catch {
    return false
  }
}

function buildHostCommand(command: string, args: string[]) {
  if (process.platform !== 'win32') return [command, ...args]
  return [windowsCliCommand(command), ...args]
}

function windowsCliCommand(command: string) {
  const candidates = [
    ...windowsPathCommandCandidates(command),
    windowsNpmShim(command),
    windowsBunShim(command),
  ].filter(Boolean) as string[]

  for (const candidate of [...new Set(candidates)]) {
    if (existsSync(candidate)) return candidate
  }

  return `${command}.cmd`
}

function windowsPathCommandCandidates(command: string) {
  const pathValue = Bun.env.PATH ?? Bun.env.Path ?? process.env.PATH ?? process.env.Path ?? ''
  const extensions = command.includes('.') ? [''] : ['.cmd', '.exe', '.bat', '.ps1', '']
  return pathValue
    .split(';')
    .filter(Boolean)
    .flatMap((dir) => extensions.map((extension) => resolve(dir, `${command}${extension}`)))
}

function windowsNpmShim(command: string) {
  const appData = Bun.env.APPDATA ?? process.env.APPDATA
  return appData ? resolve(appData, 'npm', `${command}.cmd`) : ''
}

function windowsBunShim(command: string) {
  return resolve(homedir(), '.bun', 'bin', `${command}.exe`)
}

function getWindowsCommandShell() {
  return process.env.ComSpec || `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function truthy(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function isSafeCommand(command: string) {
  return /^[a-zA-Z0-9._-]+$/.test(command)
}

function windowsShellArg(value: string) {
  if (/^[a-zA-Z0-9_./:@=\\-]+$/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function quoteForSh(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const __openClawAgentsTestHooks = {
  normalizeOpenClawAgents,
  parseOpenClawJsonOutput,
}
