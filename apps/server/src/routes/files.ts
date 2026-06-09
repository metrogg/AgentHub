import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { db, workspaces, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'
import { AppError, AppErrorCodes } from '../lib/error'

const writeFileSchema = z.object({
  workspaceId: z.string().min(1),
  filePath: z.string().min(1),
  content: z.string(),
  /** Optional: only replace a specific line range (1-based, inclusive) */
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})

const defaultDirectoryLimit = 250
const maxReadBytes = 768 * 1024

export function resolveWorkspaceReadPath(filePath: string | null | undefined, workspaceRoot: string) {
  const allowedRoot = resolve(workspaceRoot)
  const normalizedFilePath = filePath?.trim() ?? ''
  const resolvedPath = isAbsolute(normalizedFilePath)
    ? resolve(normalizedFilePath)
    : resolve(allowedRoot, normalizedFilePath)
  const rootWithSep = allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`

  if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(rootWithSep)) {
    throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '璺緞涓嶅湪宸ヤ綔鍖鸿寖鍥村唴')
  }

  const relativePath =
    resolvedPath === allowedRoot ? '' : relative(allowedRoot, resolvedPath).replace(/\\/g, '/')

  return { allowedRoot, resolvedPath, relativePath }
}

export function resolveWorkspaceWritePath(filePath: string, workspaceRoot: string) {
  const allowedRoot = resolve(workspaceRoot)
  const normalizedFilePath = filePath.trim()
  if (!normalizedFilePath) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '文件路径不能为空')
  }

  const resolvedPath = isAbsolute(normalizedFilePath)
    ? resolve(normalizedFilePath)
    : resolve(allowedRoot, normalizedFilePath)
  const rootWithSep = allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`

  if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(rootWithSep)) {
    throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '路径不在工作区范围内')
  }

  return { allowedRoot, resolvedPath }
}

export const fileRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/tree', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId')?.trim()
    const requestedPath = c.req.query('path') ?? ''
    const limit = normalizeDirectoryLimit(c.req.query('limit'))

    if (!workspaceId) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, 'Missing workspace id', { field: 'workspaceId' })
    }

    const ws = await loadOwnedWorkspace(workspaceId, user.sub)
    const { resolvedPath, relativePath } = resolveWorkspaceReadPath(requestedPath, ws.projectPath)
    const currentStat = await stat(resolvedPath).catch(() => null)
    if (!currentStat) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, 'Directory not found')
    }
    if (!currentStat.isDirectory()) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Path is not a directory')
    }

    const entries = await readdir(resolvedPath, { withFileTypes: true })
    const visibleEntries = entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      .slice(0, limit)

    const items = await Promise.all(
      visibleEntries.map(async (entry) => {
        const entryPath = resolve(resolvedPath, entry.name)
        const entryStat = await stat(entryPath)
        const entryRelativePath = relative(ws.projectPath, entryPath).replace(/\\/g, '/')
        return {
          name: entry.name,
          path: entryRelativePath,
          type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          size: entry.isFile() ? entryStat.size : null,
          modifiedAt: entryStat.mtime.toISOString(),
          extension: entry.isFile() ? extname(entry.name).toLowerCase() : null,
        }
      }),
    )

    return c.json({
      workspaceId,
      rootName: basename(ws.projectPath) || ws.name,
      path: relativePath,
      projectPath: ws.projectPath,
      items,
      truncated: entries.length > limit,
    })
  })
  .get('/read', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId')?.trim()
    const requestedPath = c.req.query('path')?.trim()

    if (!workspaceId) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, 'Missing workspace id', { field: 'workspaceId' })
    }
    if (!requestedPath) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, 'Missing file path', { field: 'path' })
    }

    const ws = await loadOwnedWorkspace(workspaceId, user.sub)
    const { resolvedPath, relativePath } = resolveWorkspaceReadPath(requestedPath, ws.projectPath)
    const fileStat = await stat(resolvedPath).catch(() => null)
    if (!fileStat) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, 'File not found')
    }
    if (!fileStat.isFile()) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Path is not a file')
    }

    const readBytes = Math.min(fileStat.size, maxReadBytes)
    const buffer = await Bun.file(resolvedPath).slice(0, readBytes).arrayBuffer()
    const bytes = Buffer.from(buffer)
    const binary = isProbablyBinary(bytes)

    return c.json({
      workspaceId,
      path: relativePath,
      name: basename(resolvedPath),
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      mimeType: contentType(resolvedPath),
      isBinary: binary,
      truncated: fileStat.size > maxReadBytes,
      content: binary ? null : bytes.toString('utf8'),
    })
  })
  .put('/', zValidator('json', writeFileSchema), async (c) => {
    const user = c.get('user')
    const { workspaceId, filePath, content, startLine, endLine } = c.req.valid('json')

    // Resolve workspace
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (!ws) {
      throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
    }
    if (ws.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.FORBIDDEN, '无权访问此工作区')
    }
    if (!ws.projectPath) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '工作区无项目路径')
    }

    const { resolvedPath } = resolveWorkspaceWritePath(filePath, ws.projectPath)

    // Line-range replacement
    if (startLine !== undefined && endLine !== undefined) {
      if (!existsSync(resolvedPath)) {
        throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, '文件不存在')
      }
      if (!statSync(resolvedPath).isFile()) {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '路径不是文件')
      }

      const existing = await readFile(resolvedPath, 'utf-8')
      const lines = existing.split('\n')
      if (startLine < 1 || startLine > lines.length) {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `起始行号超出范围 (1-${lines.length})`)
      }
      if (endLine < startLine || endLine > lines.length) {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `结束行号超出范围 (${startLine}-${lines.length})`)
      }

      const replacementLines = content.split('\n')
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines)
      await writeFile(resolvedPath, lines.join('\n'), 'utf-8')

      logger.info({ filePath: resolvedPath, startLine, endLine, workspaceId }, 'File updated (line range)')
      return c.json({ ok: true, lines: lines.length })
    }

    // Full file write
    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, content, 'utf-8')

    logger.info({ filePath: resolvedPath, workspaceId }, 'File updated (full)')
    return c.json({ ok: true })
  })

async function loadOwnedWorkspace(
  workspaceId: string,
  ownerId: string,
): Promise<typeof workspaces.$inferSelect & { projectPath: string }> {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)

  if (!ws) {
    throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '宸ヤ綔鍖轰笉瀛樺湪')
  }
  if (ws.ownerId !== ownerId) {
    throw AppError.fromCode(AppErrorCodes.FORBIDDEN, '鏃犳潈璁块棶姝ゅ伐浣滃尯')
  }
  if (!ws.projectPath) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '宸ヤ綔鍖烘棤椤圭洰璺緞')
  }
  return ws as typeof ws & { projectPath: string }
}

function normalizeDirectoryLimit(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return defaultDirectoryLimit
  return Math.min(500, Math.max(1, parsed))
}

function isProbablyBinary(buffer: Buffer) {
  if (buffer.length === 0) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  return sample.includes(0)
}

function contentType(filePath: string) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'text/javascript; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '.log') return 'text/plain; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}
