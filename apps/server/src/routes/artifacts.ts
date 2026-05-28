import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { writeFile, unlink } from 'node:fs/promises'
import { extname, resolve, relative, isAbsolute, join, normalize, sep } from 'node:path'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import AdmZip from 'adm-zip'
import { db, workspaces, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'

const WORKSPACE_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

export const artifactRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/preview-file', async (c) => {
    const rawPath = c.req.query('path')?.trim()
    if (!rawPath) throw new HTTPException(400, { message: 'Missing preview path' })

    const filePath = resolve(rawPath)
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.html' && ext !== '.htm') {
      throw new HTTPException(400, { message: 'Only HTML files can be previewed' })
    }

    const rel = relative(WORKSPACE_ROOT, filePath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new HTTPException(403, { message: 'Access denied: path outside workspace' })
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new HTTPException(404, { message: 'Preview file not found' })
    }

    return new Response(readFileSync(filePath), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    })
  })
  .post('/deploy-static', zValidator('json', z.object({ workspaceId: z.string() })), async (c) => {
    const user = c.get('user')
    const { workspaceId } = c.req.valid('json')
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub) throw new HTTPException(404, { message: 'Workspace not found' })
    if (!ws.projectPath) throw new HTTPException(400, { message: 'Workspace has no project path' })
    if (!existsSync(ws.projectPath)) throw new HTTPException(400, { message: 'Project path does not exist' })

    const deployUrl = `${new URL(c.req.url).origin}/deploy/${workspaceId}/`
    logger.info({ workspaceId, projectPath: ws.projectPath, deployUrl }, 'Static deployment created')
    return c.json({ deployId: workspaceId, url: deployUrl, status: 'ready' as const })
  })
  .post('/apply-diff', zValidator('json', z.object({ projectPath: z.string(), diff: z.string() })), async (c) => {
    const user = c.get('user')
    const { projectPath, diff } = c.req.valid('json')
    const resolvedPath = resolve(projectPath)

    // 校验 projectPath 是否属于当前用户的 workspace
    const userWorkspaces = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.sub))
    const isOwner = userWorkspaces.some(
      (ws) => ws.projectPath && resolve(ws.projectPath) === resolvedPath,
    )
    if (!isOwner) {
      throw new HTTPException(403, {
        message: 'Access denied: project path does not belong to current user',
      })
    }

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw new HTTPException(400, { message: 'Project path does not exist' })
    }
    const tmpFile = join(tmpdir(), `agenthub-diff-${Date.now()}.patch`)
    try {
      await writeFile(tmpFile, diff, 'utf8')
      // Validate first
      const check = Bun.spawn(['git', 'apply', '--check', tmpFile], {
        cwd: resolvedPath,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      })
      const checkCode = await check.exited
      if (checkCode !== 0) {
        const stderr = await new Response(check.stderr).text()
        throw new HTTPException(400, { message: `Diff validation failed: ${stderr.trim()}` })
      }
      // Apply
      const apply = Bun.spawn(['git', 'apply', tmpFile], {
        cwd: resolvedPath,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      })
      const applyCode = await apply.exited
      if (applyCode !== 0) {
        const stderr = await new Response(apply.stderr).text()
        throw new HTTPException(500, { message: `Diff apply failed: ${stderr.trim()}` })
      }
      logger.info({ projectPath: resolvedPath }, 'Diff applied successfully')
      return c.json({ success: true, message: 'Diff applied successfully' })
    } catch (err: any) {
      if (err instanceof HTTPException) throw err
      logger.error({ err: err?.message, projectPath: resolvedPath }, 'Diff apply error')
      throw new HTTPException(500, { message: err?.message || 'Failed to apply diff' })
    } finally {
      try { await unlink(tmpFile) } catch {}
    }
  })
  .get('/zip-download', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId')?.trim()
    if (!workspaceId) throw new HTTPException(400, { message: 'Missing workspaceId' })

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub) throw new HTTPException(404, { message: 'Workspace not found' })
    if (!ws.projectPath) throw new HTTPException(400, { message: 'Workspace has no project path' })
    if (!existsSync(ws.projectPath) || !statSync(ws.projectPath).isDirectory()) {
      throw new HTTPException(400, { message: 'Project path does not exist' })
    }

    const SENSITIVE_PATTERNS = [
      /^\.env/,
      /^\.git\//,
      /^node_modules\//,
      /^\.vscode\//,
      /^\.idea\//,
      /^storage\//,
      /\/\.env/,
      /\/\.git\//,
      /\/node_modules\//,
      /\/\.vscode\//,
      /\/\.idea\//,
      /\/storage\//,
    ]

    function isSensitivePath(filePath: string): boolean {
      return SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath))
    }

    try {
      const zip = new AdmZip()
      const projectPath = ws.projectPath
      const projectPrefix = projectPath.endsWith(sep) ? projectPath : `${projectPath}${sep}`
      zip.addLocalFolder(projectPath, '', (entry) => {
        const relativePath = entry.replace(projectPrefix, '')
        return !isSensitivePath(relativePath)
      })
      const buffer = zip.toBuffer()
      return new Response(buffer, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(ws.name || 'project')}.zip"`,
        },
      })
    } catch (err: any) {
      logger.error({ err: err?.message, workspaceId }, 'Failed to create zip')
      throw new HTTPException(500, { message: 'Failed to create zip archive' })
    }
  })

export async function serveDeployStatic(workspaceId: string, subPath: string): Promise<Response | null> {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  const ws = rows[0]
  if (!ws || !ws.projectPath) return null

  const projectPath = ws.projectPath
  const safePath = decodeURIComponent(subPath).replace(/^\/+/, '') || 'index.html'
  const candidate = resolve(projectPath, normalize(safePath))
  const rootWithSep = projectPath.endsWith(sep) ? projectPath : `${projectPath}${sep}`
  if (candidate !== projectPath && !candidate.startsWith(rootWithSep)) {
    return new Response('Forbidden', { status: 403 })
  }

  const filePath = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(projectPath, 'index.html')
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(Bun.file(filePath), {
    headers: { 'Content-Type': contentType(filePath) },
  })
}

function contentType(filePath: string) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.ico') return 'image/x-icon'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.ttf') return 'font/ttf'
  return 'application/octet-stream'
}
