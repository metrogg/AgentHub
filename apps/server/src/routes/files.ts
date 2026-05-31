import { writeFile, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
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

export const fileRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
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

    // Resolve and validate path is within workspace
    const resolvedPath = resolve(filePath)
    const allowedRoot = resolve(ws.projectPath)
    const rootWithSep = allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`

    if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(rootWithSep)) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '路径不在工作区范围内')
    }

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
    await writeFile(resolvedPath, content, 'utf-8')

    logger.info({ filePath: resolvedPath, workspaceId }, 'File updated (full)')
    return c.json({ ok: true })
  })
