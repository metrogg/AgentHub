import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { globalSkillRegistry, type SkillRegistry } from './skill-registry'

export type JsonObject = Record<string, unknown>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
  readOnly: boolean
  scopes: string[]
  handler: (input: JsonObject, context: ToolExecutionContext) => Promise<ToolExecutionResult>
}

export interface ToolExecutionContext {
  cwd: string
  skillRegistry: SkillRegistry
}

export interface ToolExecutionResult {
  content: string
  metadata?: JsonObject
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool)
    return this
  }

  list() {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string) {
    return this.tools.get(name)
  }

  allowedTools(permissions: string[], options: { readOnlyOnly?: boolean } = {}) {
    const normalized = new Set(permissions.map((item) => item.trim().toLowerCase()).filter(Boolean))
    const allowAllRead = normalized.has('native') || normalized.has('tools') || normalized.has('workspace:read') || normalized.has('read-only')

    return this.list().filter((tool) => {
      if (options.readOnlyOnly && !tool.readOnly) return false
      if (allowAllRead && tool.readOnly) return true
      if (normalized.has(tool.name.toLowerCase())) return true
      return tool.scopes.some((scope) => normalized.has(scope.toLowerCase()))
    })
  }

  async execute(name: string, input: JsonObject, context: ToolExecutionContext) {
    const tool = this.tools.get(name)
    if (!tool) {
      return { content: `Tool "${name}" is not registered.` }
    }
    return tool.handler(input, context)
  }
}

export const readOnlyToolRegistry = new ToolRegistry()
  .register({
    name: 'workspace_info',
    description: 'Show the current read-only workspace root and execution policy.',
    readOnly: true,
    scopes: ['workspace:read'],
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_input, context) {
      return {
        content: [
          `Workspace root: ${context.cwd}`,
          'Policy: read-only. File writes, shell commands, patching, deployment, and secret access are not available in this harness.',
        ].join('\n'),
      }
    },
  })
  .register({
    name: 'list_files',
    description: 'List files and directories under the workspace. Use this before reading unknown paths.',
    readOnly: true,
    scopes: ['workspace:read'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to list. Defaults to the workspace root.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 4, description: 'Recursive depth, default 2.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum entries to return, default 150.' },
      },
      additionalProperties: false,
    },
    async handler(input, context) {
      const target = await resolveInsideRoot(context.cwd, stringValue(input.path) || '.')
      const maxDepth = clampInt(input.maxDepth, 2, 1, 4)
      const limit = clampInt(input.limit, 150, 1, 500)
      const entries: string[] = []
      await collectFiles(context.cwd, target, { entries, maxDepth, limit, depth: 0 })
      return {
        content: entries.length ? entries.join('\n') : '(no files found)',
        metadata: { count: entries.length, truncated: entries.length >= limit },
      }
    },
  })
  .register({
    name: 'read_file',
    description: 'Read a text file from the workspace. The tool refuses paths outside the workspace and truncates large files.',
    readOnly: true,
    scopes: ['workspace:read'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        maxBytes: { type: 'integer', minimum: 1000, maximum: 60000, description: 'Maximum bytes to read, default 20000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async handler(input, context) {
      const requestedPath = stringValue(input.path)
      if (!requestedPath) return { content: 'path is required.' }

      const target = await resolveInsideRoot(context.cwd, requestedPath)
      const info = await stat(target)
      if (!info.isFile()) return { content: `${requestedPath} is not a file.` }

      const maxBytes = clampInt(input.maxBytes, 20_000, 1_000, 60_000)
      const bytesToRead = Math.min(info.size, maxBytes)
      const buffer = Buffer.alloc(bytesToRead)
      const file = await open(target, 'r')
      try {
        await file.read(buffer, 0, bytesToRead, 0)
      } finally {
        await file.close()
      }

      if (looksBinary(buffer)) {
        return { content: `${requestedPath} appears to be a binary file; content omitted.` }
      }

      const text = buffer.toString('utf8')
      const truncated = info.size > bytesToRead
      return {
        content: truncated ? `${text}\n... file truncated at ${bytesToRead} bytes ...` : text,
        metadata: { bytesRead: bytesToRead, size: info.size, truncated },
      }
    },
  })
  .register({
    name: 'search_code',
    description: 'Search workspace text with ripgrep. Use concise regex or literal patterns and inspect matching files with read_file.',
    readOnly: true,
    scopes: ['workspace:read'],
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern passed to ripgrep.' },
        path: { type: 'string', description: 'Workspace-relative path to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Optional ripgrep glob, for example *.ts.' },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum output lines, default 120.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async handler(input, context) {
      const pattern = stringValue(input.pattern)
      if (!pattern) return { content: 'pattern is required.' }
      if (pattern.length > 500) return { content: 'pattern is too long.' }

      const target = await resolveInsideRoot(context.cwd, stringValue(input.path) || '.')
      const targetRel = toPosixPath(relative(context.cwd, target)) || '.'
      const limit = clampInt(input.limit, 120, 1, 300)
      const output = await runRipgrep(context.cwd, {
        glob: stringValue(input.glob),
        limit,
        pattern,
        targetRel,
      })
      return { content: output || '(no matches)' }
    },
  })
  .register({
    name: 'list_skills',
    description: 'List available AgentHub skills with their descriptions.',
    readOnly: true,
    scopes: ['skills:read'],
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_input, context) {
      const skills = await context.skillRegistry.listSkills()
      return {
        content: skills.length
          ? skills.map((skill) => `${skill.name}: ${skill.description || '(no description)'}`).join('\n')
          : '(no skills found)',
      }
    },
  })
  .register({
    name: 'read_skill',
    description: 'Read a specific skill by name or id when its workflow is needed.',
    readOnly: true,
    scopes: ['skills:read'],
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name or directory id.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async handler(input, context) {
      const name = stringValue(input.name)
      if (!name) return { content: 'name is required.' }
      const skill = await context.skillRegistry.loadSkill(name)
      if (!skill) return { content: `Skill "${name}" was not found.` }
      return { content: limitText(`# ${skill.name}\n\n${skill.body}`, 12_000) }
    },
  })

export function createToolExecutionContext(cwd: string): ToolExecutionContext {
  return { cwd, skillRegistry: globalSkillRegistry }
}

async function collectFiles(
  root: string,
  target: string,
  state: { entries: string[]; maxDepth: number; limit: number; depth: number }
) {
  if (state.entries.length >= state.limit) return
  const info = await stat(target)
  if (!info.isDirectory()) {
    state.entries.push(toPosixPath(relative(root, target)))
    return
  }

  const children = await readdir(target, { withFileTypes: true })
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.entries.length >= state.limit) return
    if (shouldIgnore(child.name)) continue
    const childPath = resolve(target, child.name)
    const rel = toPosixPath(relative(root, childPath))
    state.entries.push(child.isDirectory() ? `${rel}/` : rel)
    if (child.isDirectory() && state.depth + 1 < state.maxDepth) {
      await collectFiles(root, childPath, { ...state, depth: state.depth + 1 })
    }
  }
}

async function resolveInsideRoot(root: string, requested: string) {
  const rootReal = await realpath(root)
  const target = resolve(rootReal, requested || '.')
  const targetReal = await realpath(target)
  if (!isInside(rootReal, targetReal)) {
    throw new Error(`Path escapes the workspace root: ${requested}`)
  }
  return targetReal
}

function isInside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))
}

function shouldIgnore(name: string) {
  return new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.nuxt',
    '.cache',
    'coverage',
    '.turbo',
  ]).has(name)
}

async function runRipgrep(
  cwd: string,
  options: { glob?: string; limit: number; pattern: string; targetRel: string }
) {
  const args = [
    '--line-number',
    '--column',
    '--color',
    'never',
    '--hidden',
    '--glob',
    '!.git/**',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!build/**',
  ]
  if (options.glob) args.push('--glob', options.glob)
  args.push(options.pattern, options.targetRel)

  try {
    const proc = Bun.spawn(['rg', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // Process may have exited.
      }
    }, 10_000)
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
    ])
    clearTimeout(timer)

    if (code === 0 || code === 1) {
      return limitLines(stdout.trim(), options.limit)
    }
    return `ripgrep failed with code ${code}: ${limitText(stderr.trim(), 2000)}`
  } catch (error: any) {
    return `ripgrep could not start: ${error?.message || 'unknown error'}`
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function looksBinary(buffer: Buffer) {
  if (!buffer.length) return false
  if (buffer.includes(0)) return true
  let suspicious = 0
  for (const byte of buffer.subarray(0, Math.min(buffer.length, 2000))) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
  }
  return suspicious / Math.min(buffer.length, 2000) > 0.08
}

function toPosixPath(value: string) {
  return value.replace(/\\/g, '/')
}

function limitLines(value: string, maxLines: number) {
  const lines = value.split(/\r?\n/).filter(Boolean)
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n... search truncated at ${maxLines} lines ...`
}

function limitText(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... output truncated ...`
}
