import { Hono } from 'hono'
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

type WorkspaceRoot = 'source' | 'target'

const SOURCE_ROOT = path.resolve(env.MASTRA_REFERENCE_ROOT)
const TARGET_ROOT = path.resolve(env.AGENTHUB_WORKSPACE_ROOT)
const MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 240
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'dist',
  'node_modules',
  'storage',
])

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])

export const workspaceRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/migration/roots', (c) =>
    c.json({
      sourceRoot: SOURCE_ROOT,
      targetRoot: TARGET_ROOT,
      maxFileBytes: MAX_FILE_BYTES,
      ignoredDirs: Array.from(IGNORED_DIRS),
    }),
  )
  .get('/migration/files', async (c) => {
    const root = readRoot(c.req.query('root'))
    const query = c.req.query('query')?.trim() ?? ''
    const limit = readLimit(c.req.query('limit'))
    const files = await listFiles(rootPath(root), query, limit, root === 'source')
    return c.json({ root, items: files })
  })
  .get('/migration/preview', async (c) => {
    const root = readRoot(c.req.query('root'))
    const relativePath = c.req.query('path')
    if (!relativePath) return c.json({ error: 'path is required' }, 400)

    const absolutePath = safeResolve(rootPath(root), relativePath)
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) return c.json({ error: 'path must point to a file' }, 400)
    if (fileStat.size > MAX_FILE_BYTES) {
      return c.json({
        path: normalizeRelative(relativePath),
        size: fileStat.size,
        truncated: true,
        content: `File is ${fileStat.size} bytes and exceeds the preview limit.`,
      })
    }

    const raw = await readFile(absolutePath, 'utf8')
    const content = raw.length > 16000 ? `${raw.slice(0, 16000)}\n\n/* preview truncated */` : raw
    return c.json({
      path: normalizeRelative(relativePath),
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      truncated: raw.length > content.length,
      content,
    })
  })
  .post('/migration/copy', async (c) => {
    const body = await c.req.json<{
      files?: Array<{ sourcePath?: string; targetPath?: string }>
      overwrite?: boolean
    }>()

    const files = body.files ?? []
    if (files.length === 0) return c.json({ error: 'files is required' }, 400)

    const results = []
    for (const item of files.slice(0, 80)) {
      const sourcePath = normalizeRelative(item.sourcePath ?? '')
      const targetPath = normalizeRelative(item.targetPath || sourcePath)

      try {
        if (!sourcePath || !targetPath) throw new Error('sourcePath and targetPath are required')
        if (hasIgnoredSegment(targetPath)) throw new Error('targetPath points to an ignored directory')

        const sourceAbsolutePath = safeResolve(SOURCE_ROOT, sourcePath)
        const targetAbsolutePath = safeResolve(TARGET_ROOT, targetPath)
        const sourceStat = await stat(sourceAbsolutePath)
        if (!sourceStat.isFile()) throw new Error('sourcePath must point to a file')
        if (sourceStat.size > MAX_FILE_BYTES) {
          throw new Error(`file exceeds ${MAX_FILE_BYTES} byte migration limit`)
        }

        const targetAlreadyExists = await exists(targetAbsolutePath)
        if (targetAlreadyExists && !body.overwrite) {
          results.push({ sourcePath, targetPath, status: 'skipped', reason: 'target exists' })
          continue
        }

        await mkdir(path.dirname(targetAbsolutePath), { recursive: true })
        await copyFile(sourceAbsolutePath, targetAbsolutePath)
        results.push({
          sourcePath,
          targetPath,
          size: sourceStat.size,
          status: targetAlreadyExists ? 'overwritten' : 'copied',
        })
      } catch (error) {
        results.push({
          sourcePath,
          targetPath,
          status: 'failed',
          reason: error instanceof Error ? error.message : 'unknown error',
        })
      }
    }

    return c.json({ results })
  })

function rootPath(root: WorkspaceRoot) {
  return root === 'source' ? SOURCE_ROOT : TARGET_ROOT
}

function readRoot(value: string | undefined): WorkspaceRoot {
  return value === 'target' ? 'target' : 'source'
}

function readLimit(value: string | undefined) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(500, Math.floor(parsed)))
}

async function listFiles(root: string, query: string, limit: number, includeTargetStatus: boolean) {
  const results: Array<{
    path: string
    size: number
    modifiedAt: string
    targetExists?: boolean
  }> = []
  const stack = ['']
  const normalizedQuery = query.toLowerCase()

  while (stack.length > 0 && results.length < limit) {
    const relativeDir = stack.pop() ?? ''
    const absoluteDir = safeResolve(root, relativeDir)
    const entries = await readdir(absoluteDir, { withFileTypes: true })

    for (const entry of entries) {
      const relativePath = normalizeRelative(path.join(relativeDir, entry.name))
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(relativePath)
        continue
      }
      if (!entry.isFile() || !isTextCandidate(entry.name)) continue
      if (normalizedQuery && !relativePath.toLowerCase().includes(normalizedQuery)) continue

      const absolutePath = safeResolve(root, relativePath)
      const fileStat = await stat(absolutePath)
      if (fileStat.size > MAX_FILE_BYTES) continue

      const item = {
        path: relativePath,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        ...(includeTargetStatus ? { targetExists: await exists(safeResolve(TARGET_ROOT, relativePath)) } : {}),
      }
      results.push(item)
      if (results.length >= limit) break
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path))
}

function safeResolve(root: string, relativePath: string) {
  const normalized = normalizeRelative(relativePath)
  if (normalized.includes('\0')) throw new Error('invalid path')
  if (path.isAbsolute(normalized)) throw new Error('absolute paths are not allowed')
  if (normalized.split('/').some((part) => part === '..')) throw new Error('parent paths are not allowed')

  const resolved = path.resolve(root, ...normalized.split('/').filter(Boolean))
  const rel = path.relative(root, resolved)
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error('path escapes the workspace root')
  }
  return resolved
}

function normalizeRelative(value: string) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
}

function hasIgnoredSegment(value: string) {
  return normalizeRelative(value)
    .split('/')
    .some((segment) => IGNORED_DIRS.has(segment))
}

function isTextCandidate(filename: string) {
  if (filename === '.env.example') return true
  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase())
}

async function exists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}
