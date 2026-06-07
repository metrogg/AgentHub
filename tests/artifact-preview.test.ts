import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, workspaces } from '../packages/db/src/index'
import { app } from '../apps/server/src/app'
import { staticPreviewUrl } from '../apps/server/src/services/code-agent-adapter'
import { previewDirectoryUrl } from '../apps/server/src/services/artifact-preview'
import {
  enrichPreviewItem,
  previewItemFromAgentArtifact,
} from '../apps/web/src/lib/artifactPreview'

describe('artifact static preview', () => {
  test('code-agent static preview URLs include workspaceId for workspace-scoped files', () => {
    const cwd = 'F:\\Before_Work\\Agenthubtest\\word'
    const filePath = 'F:\\Before_Work\\Agenthubtest\\word\\index.html'

    expect(staticPreviewUrl(cwd, 'index.html', 'workspace-1')).toBe(
      `/api/artifacts/preview-file?workspaceId=workspace-1&path=${encodeURIComponent(filePath)}`,
    )
  })

  test('legacy preview-file artifacts keep their path-scoped URL when workspaceId is missing', () => {
    const filePath = 'C:\\Users\\Mozero\\AppData\\Local\\AgentHub\\workspaces\\2026-06-06-task-1\\game.html'
    const preview = previewItemFromAgentArtifact({
      id: 'preview:game',
      type: 'preview',
      title: `Preview: ${filePath}`,
      url: `/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`,
      previewKind: 'static-html',
    })

    const enriched = enrichPreviewItem(preview, 'workspace-1')

    expect(enriched.path).toBe(filePath)
    expect(enriched.workspaceId).toBeUndefined()
    expect(enriched.url).toBe(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)
  })

  test('legacy static deploy artifacts keep their path-scoped URL when workspaceId is missing', () => {
    const filePath = 'C:\\Users\\Mozero\\AppData\\Local\\AgentHub\\workspaces\\2026-06-06-task-1\\game.html'
    const deploy = previewItemFromAgentArtifact({
      id: 'deploy:game',
      type: 'deploy',
      title: `Static deploy: ${filePath}`,
      provider: 'static',
      status: 'ready',
      url: `/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`,
    })

    const enriched = enrichPreviewItem(deploy, 'workspace-1')

    expect(enriched.path).toBe(filePath)
    expect(enriched.workspaceId).toBeUndefined()
    expect(enriched.url).toBe(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)
  })

  test('workspace-scoped preview artifacts use their source workspaceId over the current workspace', () => {
    const filePath = 'C:\\Users\\Mozero\\AppData\\Local\\AgentHub\\workspaces\\2026-06-06-task-1\\game.html'
    const preview = previewItemFromAgentArtifact({
      id: 'preview:game',
      type: 'preview',
      title: `Preview: ${filePath}`,
      url: `/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`,
      previewKind: 'static-html',
      workspaceId: 'source-workspace',
    })

    const enriched = enrichPreviewItem(preview, 'current-workspace')

    expect(enriched.path).toBe(filePath)
    expect(enriched.workspaceId).toBe('source-workspace')
    expect(enriched.url).toBe(
      `/api/artifacts/preview-file?workspaceId=source-workspace&path=${encodeURIComponent(filePath)}`,
    )
  })

  test('preview-dir rejects an arbitrary directory not under a managed root or workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), '<link rel="stylesheet" href="./assets/app.css"><div id="app"></div>')
    writeFileSync(join(root, 'assets', 'app.css'), '#app { background: black; }')

    const url = previewDirectoryUrl(join(root, 'index.html'))
    const html = await app.request(url)
    expect([401, 403]).toContain(html.status)
  })

  test('preview-file resolves legacy absolute paths under an owned workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-old-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')
    await db.insert(workspaces).values({
      id: `preview-${randomUUID()}`,
      ownerId: 'default-user',
      name: 'Legacy Preview Workspace',
      goal: 'Preview old artifacts',
      projectPath: root,
    })

    const response = await app.request(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<div>ok</div>')
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
