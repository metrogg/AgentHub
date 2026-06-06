import './setup'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewDirectoryUrl } from '../apps/server/src/services/artifact-preview'

const { app } = await import('../apps/server/src/app')
const { db, workspaces } = await import('../packages/db/src/index')

describe('artifact static preview', () => {
  test('preview-dir rejects an arbitrary directory not under a managed root or workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), '<link rel="stylesheet" href="./assets/app.css"><div id="app"></div>')
    writeFileSync(join(root, 'assets', 'app.css'), '#app { background: black; }')

    const url = previewDirectoryUrl(join(root, 'index.html'))
    const html = await app.request(url)
    expect([401, 403]).toContain(html.status)
  })

  test('preview-file rejects relative requests without workspaceId with 400', async () => {
    const response = await app.request('/api/artifacts/preview-file?path=index.html')

    expect(response.status).toBe(400)
  })

  test('preview-file rejects arbitrary absolute requests without workspaceId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-old-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')

    const response = await app.request(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)

    expect(response.status).toBe(403)
  })

  test('preview-file allows legacy absolute paths under an owned workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-workspace-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>workspace ok</div>')
    await db.insert(workspaces).values({
      ownerId: 'default-user',
      name: 'Artifact Preview Workspace',
      goal: 'Preview legacy absolute artifact URLs',
      projectPath: root,
    })

    const response = await app.request(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('workspace ok')
  })

  test('preview-file allows workspace relative paths when workspaceId is provided', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-canonical-'))
    writeFileSync(join(root, 'index.html'), '<div>canonical ok</div>')
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Artifact Preview Canonical Workspace',
        goal: 'Preview canonical artifact URLs',
        projectPath: root,
      })
      .returning()

    const response = await app.request(
      `/api/artifacts/preview-file?workspaceId=${encodeURIComponent(workspace!.id)}&path=index.html`,
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('canonical ok')
  })

  test('preview-file rejects requests with invalid workspaceId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-bad-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')

    const response = await app.request(
      `/api/artifacts/preview-file?workspaceId=nonexistent&path=${encodeURIComponent(filePath)}`,
    )

    expect([401, 404]).toContain(response.status)
  })
})
