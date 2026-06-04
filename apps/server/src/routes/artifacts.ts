import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { writeFile, unlink } from 'node:fs/promises'
import { basename, extname, resolve, isAbsolute, join, normalize, posix, sep } from 'node:path'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import AdmZip from 'adm-zip'
import { db, workspaces, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'
import { AppError, AppErrorCodes } from '../lib/error'
import { resolveDefaultWorkDir } from '../services/execution/agent-execution-envelope'
import { agentHubUserCacheRoot, agentHubUserDataRoot } from '../services/system-paths'

export const artifactRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/preview-file', async (c) => {
    const rawPath = c.req.query('path')?.trim()
    const workspaceId = c.req.query('workspaceId')?.trim()
    if (!rawPath) throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少预览路径', { field: 'path' })
    if (!workspaceId) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少 workspaceId', { field: 'workspaceId' })
    }

    const ext = extname(rawPath).toLowerCase()
    if (ext !== '.html' && ext !== '.htm') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '仅支持 HTML 文件预览')
    }

    const user = c.get('user')
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub || !ws.projectPath) {
      throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, 'Workspace not found')
    }

    const allowedRoot = resolve(ws.projectPath)
    const filePath = resolveWorkspaceFilePath(rawPath, allowedRoot)
    const rootWithSep = allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`
    if (filePath !== allowedRoot && !filePath.startsWith(rootWithSep)) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '路径不在工作区范围内')
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, '预览文件不存在')
    }

    return new Response(readFileSync(filePath), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    })
  })
  .get('/preview-dir/*', async (c) => {
    const urlPath = c.req.path
    const prefix = '/api/artifacts/preview-dir/'
    const rest = urlPath.startsWith(prefix) ? urlPath.slice(prefix.length) : ''
    if (!rest) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少预览参数')
    }
    const slashIdx = rest.indexOf('/')
    const rootEncoded = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest
    const entry = slashIdx >= 0 ? rest.slice(slashIdx + 1) : null
    if (!entry) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少文件路径')
    }

    const root = Buffer.from(rootEncoded, 'base64url').toString('utf8')
    const resolvedRoot = resolve(root)
    const user = c.get('user')
    if (!(await isPreviewRootAllowed(resolvedRoot, user.sub))) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '预览目录不在允许范围内')
    }

    const filePath = resolve(join(resolvedRoot, decodeURIComponent(entry)))
    // Security: ensure the resolved path stays under the preview root
    const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
    if (filePath !== resolvedRoot && !filePath.startsWith(rootWithSep)) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '路径不在预览目录内')
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, '文件不存在')
    }

    return new Response(Bun.file(filePath), {
      headers: { 'Content-Type': contentType(filePath) },
    })
  })
  .get('/file', async (c) => {
    const rawPath = c.req.query('path')?.trim()
    const workspaceId = c.req.query('workspaceId')?.trim()
    if (!rawPath) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, 'Missing file path', { field: 'path' })
    }
    if (!workspaceId) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, 'Missing workspace id', { field: 'workspaceId' })
    }

    const user = c.get('user')
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub || !ws.projectPath) {
      throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, 'Workspace not found')
    }

    const allowedRoot = resolve(ws.projectPath)
    const filePath = resolveWorkspaceFilePath(rawPath, allowedRoot)
    const rootWithSep = allowedRoot.endsWith(sep) ? allowedRoot : `${allowedRoot}${sep}`
    if (filePath !== allowedRoot && !filePath.startsWith(rootWithSep)) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, 'Access denied: path outside workspace')
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, 'File not found')
    }

    return new Response(Bun.file(filePath), {
      headers: {
        'Content-Type': contentType(filePath),
        'Content-Disposition': `inline; filename="${encodeURIComponent(basename(filePath))}"`,
      },
    })
  })
  .get('/:runId/download', async (c) => {
    const runId = c.req.param('runId')
    if (!runId) throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少 runId', { field: 'runId' })

    const workDir = resolveDefaultWorkDir(runId)
    if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, '工作目录不存在')
    }

    function collectFiles(dir: string, basePath = ''): { relPath: string; absPath: string }[] {
      const entries = readdirSync(dir, { withFileTypes: true })
      const results: { relPath: string; absPath: string }[] = []
      for (const entry of entries) {
        const rel = basePath ? `${basePath}/${entry.name}` : entry.name
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          results.push(...collectFiles(abs, rel))
        } else if (entry.isFile()) {
          results.push({ relPath: rel, absPath: abs })
        }
      }
      return results
    }

    const files = collectFiles(workDir)
    if (files.length === 0) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, '工作目录为空，没有可下载的产物')
    }

    const zip = new AdmZip()
    for (const file of files) {
      zip.addLocalFile(file.absPath, '', file.relPath)
    }

    const buffer = zip.toBuffer()
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(`agenthub-artifacts-${runId}`)}.zip"`,
      },
    })
  })
  .get('/:runId/:filename', async (c) => {
    const runId = c.req.param('runId')
    const rawFilename = c.req.param('filename')
    const download = c.req.query('download') === 'true'

    if (!runId || !rawFilename) {
      throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少 runId 或 filename')
    }

    const filename = decodeURIComponent(rawFilename).replace(/\\/g, '/').replace(/\.\.+/g, '.')
    if (filename.includes('..') || filename.startsWith('/')) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '文件名包含非法路径')
    }

    const workDir = resolveDefaultWorkDir(runId)
    const filePath = join(workDir, filename)
    const resolved = resolve(filePath)
    if (!resolved.startsWith(resolve(workDir))) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, '路径不在工作目录范围内')
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw AppError.fromCode(AppErrorCodes.FILE_NOT_FOUND, '文件不存在')
    }

    const fileStat = statSync(filePath)
    const headers: Record<string, string> = {
      'Content-Type': contentType(filePath),
      'Content-Length': String(fileStat.size),
    }

    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(basename(filename))}"`
    } else {
      headers['Content-Disposition'] = `inline; filename="${encodeURIComponent(basename(filename))}"`
    }

    return new Response(Bun.file(filePath), { headers })
  })
  .post('/deploy-static', zValidator('json', z.object({ workspaceId: z.string() })), async (c) => {
    const user = c.get('user')
    const { workspaceId } = c.req.valid('json')
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
    if (!ws.projectPath) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '工作区未设置项目路径')
    if (!existsSync(ws.projectPath)) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '项目路径不存在')

    const deployUrl = `${new URL(c.req.url).origin}/deploy/${workspaceId}/`
    logger.info({ workspaceId, projectPath: ws.projectPath, deployUrl }, 'Static deployment created')
    return c.json({ deployId: workspaceId, url: deployUrl, status: 'ready' as const })
  })
  .post('/apply-diff', zValidator('json', z.object({ workspaceId: z.string(), diff: z.string() })), async (c) => {
    const user = c.get('user')
    const { workspaceId, diff } = c.req.valid('json')

    // 后端根据 workspaceId 获取 projectPath，禁止前端传任意路径
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
    }
    if (!ws.projectPath) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '工作区未设置项目路径')
    }

    const resolvedPath = resolve(ws.projectPath)
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '项目路径不存在')
    }
    try {
      const result = await acceptDiffInWorkspace(resolvedPath, diff)
      logger.info(
        {
          projectPath: resolvedPath,
          stagedFiles: result.stagedFiles,
          appliedPatch: result.appliedPatch,
        },
        'Diff accepted and staged successfully',
      )
      return c.json({ success: true, message: result.message, stagedFiles: result.stagedFiles })
    } catch (err: any) {
      if (err instanceof AppError) throw err
      logger.error({ err: err?.message, projectPath: resolvedPath }, 'Diff apply error')
      throw AppError.internal(AppErrorCodes.DIFF_APPLY_FAILED, err?.message || 'Diff 应用失败')
    }
  })
  .get('/zip-download', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId')?.trim()
    if (!workspaceId) throw AppError.fromCode(AppErrorCodes.MISSING_FIELD, '缺少 workspaceId', { field: 'workspaceId' })

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!ws || ws.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
    if (!ws.projectPath) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '工作区未设置项目路径')
    if (!existsSync(ws.projectPath) || !statSync(ws.projectPath).isDirectory()) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '项目路径不存在')
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
      throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, 'ZIP 压缩失败')
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

interface GitCommandResult {
  code: number
  stdout: string
  stderr: string
}

interface AcceptDiffResult {
  appliedPatch: boolean
  message: string
  stagedFiles: string[]
}

async function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function unquoteDiffPath(value: string) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  return trimmed
}

function splitDiffGitHeaderPaths(header: string) {
  const paths: string[] = []
  const pattern = /"((?:\\.|[^"\\])*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(header))) {
    const token = match[0]
    paths.push(unquoteDiffPath(token))
  }
  return paths
}

function normalizeDiffTargetPath(value: string): string | null {
  const withoutTimestamp = value.split('\t')[0]?.trim() ?? ''
  const unquoted = unquoteDiffPath(withoutTimestamp)
  if (!unquoted || unquoted === '/dev/null' || unquoted === 'dev/null') return null

  const withoutPrefix = unquoted.replace(/^[ab]\//, '')
  const normalized = posix.normalize(withoutPrefix.replace(/\\/g, '/')).replace(/^\.\//, '')
  if (!normalized || normalized === '.') return null
  return normalized
}

export function extractDiffTargetPaths(diff: string): string[] {
  const paths = new Set<string>()
  for (const rawLine of diff.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('diff --git ')) {
      const headerPaths = splitDiffGitHeaderPaths(line.slice('diff --git '.length))
      for (const headerPath of headerPaths) {
        const normalized = normalizeDiffTargetPath(headerPath)
        if (normalized) paths.add(normalized)
      }
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const normalized = normalizeDiffTargetPath(line.slice(4))
      if (normalized) paths.add(normalized)
    }
  }
  return [...paths]
}

function assertDiffPathsStayInWorkspace(projectPath: string, paths: string[]) {
  const root = resolve(projectPath)
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
  for (const filePath of paths) {
    if (
      filePath.includes('\0') ||
      filePath === '..' ||
      filePath.startsWith('../') ||
      filePath.startsWith('/') ||
      /^[A-Za-z]:/.test(filePath)
    ) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, `Diff 包含非法路径: ${filePath}`)
    }
    const resolved = resolve(root, filePath)
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw AppError.fromCode(AppErrorCodes.FILE_ACCESS_DENIED, `Diff 路径不在工作区范围内: ${filePath}`)
    }
  }
}

async function ensureGitRepository(projectPath: string) {
  const probe = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (probe.code === 0 && probe.stdout.trim() === 'true') return

  const init = await runGit(projectPath, ['init'])
  if (init.code !== 0) {
    throw AppError.internal(AppErrorCodes.DIFF_APPLY_FAILED, `Git 仓库初始化失败: ${init.stderr.trim()}`)
  }
}

async function gitStatusForPaths(projectPath: string, paths: string[]) {
  const status = await runGit(projectPath, ['status', '--porcelain', '--untracked-files=all', '--', ...paths])
  if (status.code !== 0) {
    throw AppError.internal(AppErrorCodes.DIFF_APPLY_FAILED, `读取 Git 状态失败: ${status.stderr.trim()}`)
  }
  return status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
}

async function gitStagedFilesForPaths(projectPath: string, paths: string[]) {
  const diff = await runGit(projectPath, ['diff', '--cached', '--name-only', '--', ...paths])
  if (diff.code !== 0) {
    throw AppError.internal(AppErrorCodes.DIFF_APPLY_FAILED, `读取暂存区失败: ${diff.stderr.trim()}`)
  }
  return diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

async function tryApplyDiffPatch(projectPath: string, diff: string) {
  const tmpFile = join(tmpdir(), `agenthub-diff-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`)
  try {
    await writeFile(tmpFile, diff, 'utf8')
    const check = await runGit(projectPath, ['apply', '--check', tmpFile])
    if (check.code !== 0) {
      return { applied: false, stderr: check.stderr.trim() }
    }

    const apply = await runGit(projectPath, ['apply', tmpFile])
    if (apply.code !== 0) {
      throw AppError.internal(AppErrorCodes.DIFF_APPLY_FAILED, `Diff 应用失败: ${apply.stderr.trim()}`)
    }
    return { applied: true, stderr: '' }
  } finally {
    try {
      await unlink(tmpFile)
    } catch {}
  }
}

function isAlreadyMaterializedDiffFailure(stderr: string) {
  return /already exists in working directory/i.test(stderr) || /already exists/i.test(stderr)
}

function buildDiffAcceptanceMessage(appliedPatch: boolean, stagedFiles: string[]) {
  if (stagedFiles.length === 0) {
    return 'Diff 对应文件没有新的可暂存变更。'
  }
  const preview = stagedFiles.slice(0, 3).join('、')
  const suffix = stagedFiles.length > 3 ? ` 等 ${stagedFiles.length} 个文件` : ''
  return appliedPatch
    ? `已应用并暂存 ${preview}${suffix}。`
    : `已暂存 ${preview}${suffix}。`
}

export async function acceptDiffInWorkspace(projectPath: string, diff: string): Promise<AcceptDiffResult> {
  const targetPaths = extractDiffTargetPaths(diff)
  if (targetPaths.length === 0) {
    throw AppError.fromCode(AppErrorCodes.DIFF_VALIDATION_FAILED, 'Diff 中没有可识别的文件路径')
  }

  assertDiffPathsStayInWorkspace(projectPath, targetPaths)
  await ensureGitRepository(projectPath)

  let appliedPatch = false
  const statusBefore = await gitStatusForPaths(projectPath, targetPaths)
  if (statusBefore.length === 0) {
    const applyResult = await tryApplyDiffPatch(projectPath, diff)
    if (!applyResult.applied) {
      if (!isAlreadyMaterializedDiffFailure(applyResult.stderr)) {
        throw AppError.fromCode(AppErrorCodes.DIFF_VALIDATION_FAILED, `Diff 验证失败: ${applyResult.stderr}`)
      }
      logger.info(
        { projectPath, targetPaths, stderr: applyResult.stderr },
        'Diff patch already materialized in workspace; staging existing files',
      )
    } else {
      appliedPatch = true
    }
  }

  const add = await runGit(projectPath, ['add', '--all', '--', ...targetPaths])
  if (add.code !== 0) {
    throw AppError.internal(AppErrorCodes.DIFF_APPLY_FAILED, `暂存 Diff 失败: ${add.stderr.trim()}`)
  }

  const stagedFiles = await gitStagedFilesForPaths(projectPath, targetPaths)
  return {
    appliedPatch,
    stagedFiles,
    message: buildDiffAcceptanceMessage(appliedPatch, stagedFiles),
  }
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
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.doc') return 'application/msword'
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (ext === '.ppt') return 'application/vnd.ms-powerpoint'
  if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  if (ext === '.xls') return 'application/vnd.ms-excel'
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.ttf') return 'font/ttf'
  return 'application/octet-stream'
}

function resolveWorkspaceFilePath(rawPath: string, workspaceRoot: string) {
  const normalizedPath = normalize(rawPath)
  return isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(workspaceRoot, normalizedPath)
}

function isPathUnder(child: string, parent: string) {
  const resolvedParent = resolve(parent)
  const parentWithSep = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`
  return child === resolvedParent || child.startsWith(parentWithSep)
}

async function isPreviewRootAllowed(resolvedRoot: string, ownerId: string): Promise<boolean> {
  const managedRoots = [agentHubUserCacheRoot(), agentHubUserDataRoot()]
  if (managedRoots.some((managed) => isPathUnder(resolvedRoot, managed))) {
    return true
  }

  const ownedWorkspaces = await db
    .select({ projectPath: workspaces.projectPath })
    .from(workspaces)
    .where(eq(workspaces.ownerId, ownerId))
  return ownedWorkspaces.some(
    (ws) => ws.projectPath && isPathUnder(resolvedRoot, resolve(ws.projectPath)),
  )
}
