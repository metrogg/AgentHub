import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, relative, isAbsolute } from 'node:path'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

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
