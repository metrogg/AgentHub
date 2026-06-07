import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, workspaces, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { AppError, AppErrorCodes } from '../lib/error'

export const gitRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)

// Helper: run a git command in a workspace, return { code, stdout, stderr }
async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

// Helper: resolve and authorize workspace
async function resolveWorkspace(workspaceId: string, ownerId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!ws || ws.ownerId !== ownerId) throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
  if (!ws.projectPath) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '工作区未设置项目路径')
  return ws
}

// GET /api/git/:workspaceId/status
gitRoutes.get('/:workspaceId/status', async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const [branchRes, statusRes, remoteRes] = await Promise.all([
    runGit(ws.projectPath!, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(ws.projectPath!, ['status', '--porcelain', '-u']),
    runGit(ws.projectPath!, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ])

  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null
  const upstream = remoteRes.code === 0 ? remoteRes.stdout.trim() : null

  // Parse porcelain output
  const files: Array<{ path: string; x: string; y: string }> = []
  for (const line of statusRes.stdout.split('\n')) {
    if (line.length < 4) continue
    files.push({ x: line[0]!, y: line[1]!, path: line.slice(3).trim() })
  }

  // ahead/behind
  let ahead = 0, behind = 0
  if (upstream) {
    const abRes = await runGit(ws.projectPath!, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    if (abRes.code === 0) {
      const parts = abRes.stdout.trim().split(/\s+/)
      ahead = parseInt(parts[0] ?? '0', 10) || 0
      behind = parseInt(parts[1] ?? '0', 10) || 0
    }
  }

  return c.json({ branch, upstream, ahead, behind, files })
})

// GET /api/git/:workspaceId/diff?path=<file>
gitRoutes.get('/:workspaceId/diff', async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const filePath = c.req.query('path')
  const staged = c.req.query('staged') === 'true'
  const args = staged
    ? ['diff', '--cached', '--', ...(filePath ? [filePath] : [])]
    : ['diff', 'HEAD', '--', ...(filePath ? [filePath] : [])]
  const res = await runGit(ws.projectPath!, args)
  return c.json({ diff: res.stdout })
})

// GET /api/git/:workspaceId/log
gitRoutes.get('/:workspaceId/log', async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const res = await runGit(ws.projectPath!, ['log', '--oneline', '--decorate', '-20'])
  const commits = res.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const spaceIdx = line.indexOf(' ')
    return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) }
  })
  return c.json({ commits })
})

// POST /api/git/:workspaceId/stage  { paths: string[] | 'all' }
gitRoutes.post('/:workspaceId/stage', zValidator('json', z.object({ paths: z.union([z.literal('all'), z.array(z.string())]) })), async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const { paths } = c.req.valid('json')
  const args = paths === 'all' ? ['add', '-A'] : ['add', '--', ...paths]
  const res = await runGit(ws.projectPath!, args)
  if (res.code !== 0) throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, res.stderr.trim() || '暂存失败')
  return c.json({ ok: true })
})

// POST /api/git/:workspaceId/unstage  { paths: string[] | 'all' }
gitRoutes.post('/:workspaceId/unstage', zValidator('json', z.object({ paths: z.union([z.literal('all'), z.array(z.string())]) })), async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const { paths } = c.req.valid('json')
  const args = paths === 'all' ? ['reset', 'HEAD'] : ['reset', 'HEAD', '--', ...paths]
  const res = await runGit(ws.projectPath!, args)
  if (res.code !== 0) throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, res.stderr.trim() || 'Unstage 失败')
  return c.json({ ok: true })
})

// POST /api/git/:workspaceId/commit  { message: string }
gitRoutes.post('/:workspaceId/commit', zValidator('json', z.object({ message: z.string().min(1).max(2000) })), async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const { message } = c.req.valid('json')
  const res = await runGit(ws.projectPath!, ['commit', '-m', message])
  if (res.code !== 0) throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, res.stderr.trim() || '提交失败')
  return c.json({ ok: true, output: res.stdout.trim() })
})

// POST /api/git/:workspaceId/push
gitRoutes.post('/:workspaceId/push', async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const res = await runGit(ws.projectPath!, ['push'])
  if (res.code !== 0) throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, res.stderr.trim() || '推送失败')
  return c.json({ ok: true, output: res.stdout.trim() || res.stderr.trim() })
})

// POST /api/git/:workspaceId/pull
gitRoutes.post('/:workspaceId/pull', async (c) => {
  const ws = await resolveWorkspace(c.req.param('workspaceId'), c.get('user').sub)
  const res = await runGit(ws.projectPath!, ['pull'])
  if (res.code !== 0) throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, res.stderr.trim() || '拉取失败')
  return c.json({ ok: true, output: res.stdout.trim() })
})
