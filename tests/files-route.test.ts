import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppErrorCodes } from '../apps/server/src/lib/error'
import { resolveWorkspaceWritePath } from '../apps/server/src/routes/files'
import { app } from '../apps/server/src/app'
import { db, eq, workspaces } from '../packages/db/src/index'

describe('files route path resolution', () => {
  const workspaceIds: string[] = []

  afterEach(async () => {
    const ids = workspaceIds.splice(0)
    await Promise.all(ids.map((id) => db.delete(workspaces).where(eq(workspaces.id, id))))
  })

  test('resolves workspace-relative paths inside the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))

    const result = resolveWorkspaceWritePath('index.html', root)

    expect(result.resolvedPath).toBe(resolve(root, 'index.html'))
  })

  test('allows absolute paths only when they stay inside the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))
    const absoluteFile = join(root, 'nested', 'index.html')

    const result = resolveWorkspaceWritePath(absoluteFile, root)

    expect(result.resolvedPath).toBe(resolve(absoluteFile))
  })

  test('rejects paths escaping the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))

    expect(() => resolveWorkspaceWritePath('../outside.html', root)).toThrow(
      expect.objectContaining({ code: AppErrorCodes.FILE_ACCESS_DENIED }),
    )
  })

  test('lists workspace files through the route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true\n')
    const workspaceId = `files-${randomUUID()}`
    workspaceIds.push(workspaceId)
    await db.insert(workspaces).values({
      id: workspaceId,
      ownerId: 'default-user',
      name: 'Files Workspace',
      goal: 'Browse files',
      projectPath: root,
    })

    const response = await app.request(
      `/api/files/tree?workspaceId=${encodeURIComponent(workspaceId)}&path=src`,
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      path: string
      items: Array<{ name: string; path: string; type: string }>
    }
    expect(body.path).toBe('src')
    expect(body.items).toContainEqual(
      expect.objectContaining({ name: 'index.ts', path: 'src/index.ts', type: 'file' }),
    )
  })

  test('reads a workspace text file through the route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'notes.md'), '# Notes\n\nHello AgentHub.\n')
    const workspaceId = `files-${randomUUID()}`
    workspaceIds.push(workspaceId)
    await db.insert(workspaces).values({
      id: workspaceId,
      ownerId: 'default-user',
      name: 'Files Workspace',
      goal: 'Read files',
      projectPath: root,
    })

    const response = await app.request(
      `/api/files/read?workspaceId=${encodeURIComponent(workspaceId)}&path=src%2Fnotes.md`,
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      content: string | null
      isBinary: boolean
      path: string
    }
    expect(body.path).toBe('src/notes.md')
    expect(body.isBinary).toBe(false)
    expect(body.content).toContain('Hello AgentHub.')
  })

  test('file tree route rejects paths outside the workspace root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-files-'))
    const workspaceId = `files-${randomUUID()}`
    workspaceIds.push(workspaceId)
    await db.insert(workspaces).values({
      id: workspaceId,
      ownerId: 'default-user',
      name: 'Files Workspace',
      goal: 'Browse files',
      projectPath: root,
    })

    const response = await app.request(
      `/api/files/tree?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent('../outside')}`,
    )

    expect(response.status).toBe(403)
  })
})
