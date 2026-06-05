#!/usr/bin/env bun
/**
 * agenthub CLI — AgentHub Controller command-line interface.
 * Aligned with HiClaw's `hiclaw` CLI pattern.
 *
 * Environment:
 *   AGENTHUB_CONTROLLER_URL  (default: http://localhost:3001)
 *   AGENTHUB_MANAGER_TOKEN   (Matrix access token for auth)
 */

const CONTROLLER_URL = process.env.AGENTHUB_CONTROLLER_URL || 'http://localhost:3001'
const MANAGER_TOKEN = process.env.AGENTHUB_MANAGER_TOKEN || ''
const VERSION = '0.1.0'

interface ApiOptions {
  method?: string
  body?: unknown
  query?: Record<string, string>
}

async function api(path: string, options: ApiOptions = {}): Promise<unknown> {
  const url = new URL(path, CONTROLLER_URL)
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v)
    }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (MANAGER_TOKEN) headers['Authorization'] = `Bearer ${MANAGER_TOKEN}`
  const resp = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await resp.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text }
  if (!resp.ok) {
    const msg = typeof data === 'object' && data !== null && 'error' in data
      ? (data as any).error : `HTTP ${resp.status}: ${text.slice(0, 200)}`
    throw new Error(msg)
  }
  return data
}

async function managerAction(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return api('/api/internal/manager/actions', { method: 'POST', body: { action, params } })
}

// ─── Argument Parser ──────────────────────────────────────────────────

function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '-o' || arg === '--output') {
      flags['output'] = args[i + 1] || 'json'
      i += 2
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) { flags[key] = next; i += 2 }
      else { flags[key] = 'true'; i++ }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg[1]!
      const next = args[i + 1]
      if (next && !next.startsWith('-')) { flags[key] = next; i += 2 }
      else { flags[key] = 'true'; i++ }
    } else {
      positional.push(arg); i++
    }
  }
  return { flags, positional }
}

function flag(flags: Record<string, string>, key: string): string | undefined { return flags[key] }
function requireFlag(flags: Record<string, string>, key: string): string {
  const val = flags[key]
  if (!val) { console.error(`Error: --${key} is required`); process.exit(1) }
  return val
}

function output(data: unknown, flags?: Record<string, string>) {
  if (flags?.output === 'raw' || typeof data === 'string') { console.log(data) }
  else { console.log(JSON.stringify(data, null, 2)) }
}

// ─── Worker Commands ─────────────────────────────────────────────────

async function cmdWorker(args: string[]) {
  const [sub, ...rest] = args
  const { flags: f, positional } = parseArgs(rest)

  switch (sub) {
    case 'create': {
      const name = requireFlag(f, 'name')
      const workspaceId = requireFlag(f, 'workspace')
      const result = await managerAction('create_worker', {
        workspaceId, name,
        runtimeType: f.runtime || 'code-agent',
        codeAgentType: f['code-agent'] || 'codex',
        modelId: f.model || undefined,
      })
      output(result, f)
      break
    }
    case 'list': {
      const workspaceId = requireFlag(f, 'workspace')
      const result = await managerAction('list_workers', { workspaceId })
      output(result, f)
      break
    }
    case 'get': {
      // agenthub worker get <name> — alias for status by name
      const name = positional[0]
      if (!name) { console.error('Error: worker name is required'); process.exit(1) }
      const workspaceId = f.workspace || ''
      const result = await managerAction('list_workers', { workspaceId })
      // Filter by name client-side
      const workers = (result as any)?.workers || (result as any)?.result?.workers || []
      const found = workers.find((w: any) => w.name === name)
      if (!found) { console.error(`Worker not found: ${name}`); process.exit(1) }
      output(found, f)
      break
    }
    case 'update': {
      const id = requireFlag(f, 'id')
      const body: Record<string, unknown> = {}
      if (f.model) body.modelId = f.model
      if (f.runtime) body.runtimeType = f.runtime
      if (f.skills) body.skillIds = f.skills.split(',').map((s: string) => s.trim())
      const result = await api(`/api/controller/workers/${id}`, { method: 'PATCH', body })
      output(result, f)
      break
    }
    case 'delete': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/workers/${id}`, { method: 'DELETE' })
      output(result, f)
      break
    }
    case 'wake': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/workers/${id}/wake`, { method: 'POST' })
      output(result, f)
      break
    }
    case 'stop': case 'sleep': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/workers/${id}/stop`, { method: 'POST' })
      output(result, f)
      break
    }
    case 'ensure-ready': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/workers/${id}/reconcile`, { method: 'POST' })
      output(result, f)
      break
    }
    case 'status': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/workers/${id}`)
      output(result, f)
      break
    }
    case 'apply': {
      // agenthub worker apply --name <N> --model <M> [--expose 8080] [--package nacos://...]
      const name = requireFlag(f, 'name')
      const workspaceId = f.workspace || ''
      const result = await managerAction('create_worker', {
        workspaceId, name,
        runtimeType: f.runtime || 'code-agent',
        codeAgentType: f['code-agent'] || 'codex',
        modelId: f.model || undefined,
      })
      output(result, f)
      break
    }
    case 'report-ready': {
      // Used by Worker process to report readiness
      const name = f.name || process.env.AGENTHUB_WORKER_NAME || ''
      const result = await api('/api/internal/worker/report-ready', {
        method: 'POST',
        body: { workerName: name },
      })
      output(result, f)
      break
    }
    default:
      console.error('Usage: agenthub worker <create|list|get|update|delete|wake|stop|sleep|ensure-ready|status|apply|report-ready> [options]')
      process.exit(1)
  }
}

// ─── Task Commands ───────────────────────────────────────────────────

async function cmdTask(args: string[]) {
  const [sub, ...rest] = args
  const { flags: f } = parseArgs(rest)

  switch (sub) {
    case 'create': {
      const workspaceId = requireFlag(f, 'workspace')
      const title = requireFlag(f, 'title')
      const result = await managerAction('create_task', {
        workspaceId,
        runId: f.run || undefined,
        title,
        spec: f.spec || title,
        assignToAgentId: f['assign-to'] || f.agent || undefined,
        assignToWorkerInstanceId: f['worker-instance'] || undefined,
      })
      output(result, f)
      break
    }
    case 'list': {
      const runId = requireFlag(f, 'run')
      const result = await api(`/api/orchestrator-runs/${runId}/tasks`)
      output(result, f)
      break
    }
    case 'status': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/workspace-tasks/${id}`)
      output(result, f)
      break
    }
    case 'complete': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/tasks/${id}/complete`, { method: 'POST', body: { runId: f.run || '' } })
      output(result, f)
      break
    }
    case 'fail': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/tasks/${id}/fail`, { method: 'POST', body: { error: f.reason || 'Task failed' } })
      output(result, f)
      break
    }
    case 'cancel': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/controller/tasks/${id}/cancel`, { method: 'POST', body: { reason: f.reason || 'Cancelled' } })
      output(result, f)
      break
    }
    case 'retry': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/workspace-tasks/${id}/retry`, { method: 'POST' })
      output(result, f)
      break
    }
    default:
      console.error('Usage: agenthub task <create|list|status|complete|fail|cancel|retry> [options]')
      process.exit(1)
  }
}

// ─── Run Commands ────────────────────────────────────────────────────

async function cmdRun(args: string[]) {
  const [sub, ...rest] = args
  const { flags: f } = parseArgs(rest)

  switch (sub) {
    case 'create': {
      const workspaceId = requireFlag(f, 'workspace')
      const goal = requireFlag(f, 'goal')
      const result = await api('/api/orchestrator-runs', {
        method: 'POST',
        body: { workspaceId, groupSessionId: f.session || '', goal },
      })
      output(result, f)
      break
    }
    case 'status': {
      const id = requireFlag(f, 'id')
      const result = await managerAction('get_run_status', { runId: id })
      output(result, f)
      break
    }
    case 'cancel': {
      const id = requireFlag(f, 'id')
      const result = await api(`/api/orchestrator-runs/${id}/cancel`, {
        method: 'POST', body: { reason: f.reason || 'Cancelled by manager' },
      })
      output(result, f)
      break
    }
    case 'list': {
      const workspaceId = requireFlag(f, 'workspace')
      const result = await api(`/api/orchestrator-runs?workspaceId=${workspaceId}`)
      output(result, f)
      break
    }
    default:
      console.error('Usage: agenthub run <create|status|cancel|list> [options]')
      process.exit(1)
  }
}

// ─── Room Commands ───────────────────────────────────────────────────

async function cmdRoom(args: string[]) {
  const [sub, ...rest] = args
  const { flags: f } = parseArgs(rest)

  switch (sub) {
    case 'create': {
      const ownerId = requireFlag(f, 'owner')
      const title = requireFlag(f, 'title')
      const result = await api('/api/rooms', {
        method: 'POST',
        body: { ownerId, title, kind: f.kind || 'group', workspaceId: f.workspace || undefined },
      })
      output(result, f)
      break
    }
    case 'events': case 'timeline': {
      const roomId = requireFlag(f, 'room')
      const result = await api(`/api/rooms/${roomId}/timeline?limit=${f.limit || '20'}`)
      output(result, f)
      break
    }
    case 'mention': {
      const roomId = requireFlag(f, 'room')
      const agentId = requireFlag(f, 'agent')
      const body = requireFlag(f, 'body')
      const result = await api(`/api/rooms/${roomId}/mention`, {
        method: 'POST', body: { workspaceAgentId: agentId, body },
      })
      output(result, f)
      break
    }
    default:
      console.error('Usage: agenthub room <create|events|mention> [options]')
      process.exit(1)
  }
}

// ─── Team Commands ───────────────────────────────────────────────────

async function cmdTeam(args: string[]) {
  const [sub, ...rest] = args
  const { flags: f } = parseArgs(rest)

  switch (sub) {
    case 'create': {
      const name = requireFlag(f, 'name')
      const workspaceId = requireFlag(f, 'workspace')
      const result = await managerAction('create_team', {
        workspaceId, name,
        leaderName: f['leader-name'] || undefined,
        leaderModel: f['leader-model'] || undefined,
        workers: f.workers ? f.workers.split(',').map((w: string) => w.trim()) : undefined,
        description: f.description || undefined,
      })
      output(result, f)
      break
    }
    case 'list': {
      const workspaceId = requireFlag(f, 'workspace')
      const result = await managerAction('list_teams', { workspaceId })
      output(result, f)
      break
    }
    case 'get': {
      const name = f.name || args[0]
      if (!name) { console.error('Error: team name is required'); process.exit(1) }
      const workspaceId = f.workspace || ''
      const result = await managerAction('get_team', { workspaceId, teamName: name })
      output(result, f)
      break
    }
    case 'update': {
      const name = requireFlag(f, 'name')
      const workspaceId = f.workspace || ''
      const body: Record<string, unknown> = { teamName: name, workspaceId }
      if (f.description) body.description = f.description
      if (f['leader-model']) body.leaderModel = f['leader-model']
      if (f.workers) body.workers = f.workers.split(',').map((w: string) => w.trim())
      const result = await managerAction('update_team', body)
      output(result, f)
      break
    }
    case 'delete': {
      const name = requireFlag(f, 'name')
      const workspaceId = f.workspace || ''
      const result = await managerAction('delete_team', { workspaceId, teamName: name })
      output(result, f)
      break
    }
    default:
      console.error('Usage: agenthub team <create|list|get|update|delete> [options]')
      process.exit(1)
  }
}

// ─── Human Commands ──────────────────────────────────────────────────

async function cmdHuman(args: string[]) {
  const [sub, ...rest] = args
  const { flags: f } = parseArgs(rest)

  switch (sub) {
    case 'create': {
      const name = requireFlag(f, 'name')
      const displayName = requireFlag(f, 'display-name')
      const workspaceId = f.workspace || ''
      const result = await managerAction('create_human', {
        workspaceId, name, displayName,
        email: f.email || undefined,
        permissionLevel: f['permission-level'] ? Number(f['permission-level']) : undefined,
      })
      output(result, f)
      break
    }
    case 'list': {
      const workspaceId = requireFlag(f, 'workspace')
      const result = await managerAction('list_humans', { workspaceId })
      output(result, f)
      break
    }
    case 'delete': {
      const name = requireFlag(f, 'name')
      const workspaceId = f.workspace || ''
      const result = await managerAction('delete_human', { workspaceId, humanName: name })
      output(result, f)
      break
    }
    default:
      console.error('Usage: agenthub human <create|list|delete> [options]')
      process.exit(1)
  }
}

// ─── Apply Command (Declarative) ─────────────────────────────────────

async function cmdApply(args: string[]) {
  const { flags: f } = parseArgs(args)
  const file = f.file || f.f
  if (!file) {
    // Inline apply: agenthub apply worker --name <N> ...
    const resource = args[0]
    if (resource === 'worker') {
      return cmdWorker(['apply', ...args.slice(1)])
    }
    console.error('Usage: agenthub apply -f <yaml-file>  OR  agenthub apply worker --name <N> ...')
    process.exit(1)
  }
  // Read YAML file and POST to controller
  const { readFileSync } = require('node:fs')
  const content = readFileSync(file, 'utf8')
  const result = await api('/api/controller/apply', {
    method: 'POST',
    body: { yaml: content },
  })
  output(result, f)
}

// ─── Status & Version ────────────────────────────────────────────────

async function cmdStatus(args: string[]) {
  const { flags: f } = parseArgs(args)
  const result = await managerAction('get_platform_status')
  output(result, f)
}

async function cmdVersion(args: string[]) {
  const { flags: f } = parseArgs(args)
  output({ version: VERSION, controllerUrl: CONTROLLER_URL }, f)
}

// ─── Main ────────────────────────────────────────────────────────────

const USAGE = `AgentHub CLI v${VERSION} — Controller command interface

Usage:
  agenthub worker   <create|list|get|update|delete|wake|stop|sleep|ensure-ready|status|apply|report-ready>
  agenthub task     <create|list|status|complete|fail|cancel|retry>
  agenthub run      <create|status|cancel|list>
  agenthub room     <create|events|mention>
  agenthub team     <create|list|get|update|delete>
  agenthub human    <create|list|delete>
  agenthub apply    -f <yaml-file>  |  agenthub apply worker --name <N> ...
  agenthub status
  agenthub version
  agenthub state    --workspace <id>
  agenthub heartbeat --workspace <id>

Environment:
  AGENTHUB_CONTROLLER_URL   (default: http://localhost:3001)
  AGENTHUB_MANAGER_TOKEN    (Matrix access token for auth)

Common flags:
  -o, --output json|raw     Output format (default: json)

Examples:
  agenthub worker list --workspace ws-123
  agenthub worker create --workspace ws-123 --name builder --code-agent codex
  agenthub worker update --id wk-456 --model gpt-4o
  agenthub team create --workspace ws-123 --name dev-team --leader-name leader --workers a,b,c
  agenthub task create --workspace ws-123 --title "Build UI" --assign-to ag-456
  agenthub run status --id run-789
  agenthub room mention --room rm-abc --agent ag-456 --body "Please start task tk-def"`

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) { console.log(USAGE); return }

  const [command, ...rest] = args
  try {
    switch (command) {
      case 'worker':    await cmdWorker(rest); break
      case 'task':      await cmdTask(rest); break
      case 'run':       await cmdRun(rest); break
      case 'room':      await cmdRoom(rest); break
      case 'team':      await cmdTeam(rest); break
      case 'human':     await cmdHuman(rest); break
      case 'apply':     await cmdApply(rest); break
      case 'status':    await cmdStatus(rest); break
      case 'version':   await cmdVersion(rest); break
      case 'state':     await cmdState(rest); break
      case 'heartbeat': await cmdHeartbeat(rest); break
      default:
        console.error(`Unknown command: ${command}\nRun 'agenthub' for usage.`)
        process.exit(1)
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

async function cmdState(args: string[]) {
  const { flags: f } = parseArgs(args)
  const workspaceId = requireFlag(f, 'workspace')
  const result = await managerAction('get_workspace_state', { workspaceId })
  output(result, f)
}

async function cmdHeartbeat(args: string[]) {
  const { flags: f } = parseArgs(args)
  const workspaceId = requireFlag(f, 'workspace')
  const result = await managerAction('heartbeat', { workspaceId })
  output(result, f)
}

main()
