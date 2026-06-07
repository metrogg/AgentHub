import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from '../apps/server/src/app'
import { previewDirectoryUrl } from '../apps/server/src/services/artifact-preview'
import {
  enrichPreviewItem,
  previewItemFromAgentArtifact,
} from '../apps/web/src/lib/artifactPreview'

describe('artifact static preview', () => {
  test('workspace-backed preview artifacts retain their file path for workspaceId enrichment', () => {
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
    expect(enriched.url).toBe(
      `/api/artifacts/preview-file?workspaceId=workspace-1&path=${encodeURIComponent(filePath)}`,
    )
  })

  test('static deploy artifacts retain their file path for workspaceId enrichment', () => {
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
    expect(enriched.url).toBe(
      `/api/artifacts/preview-file?workspaceId=workspace-1&path=${encodeURIComponent(filePath)}`,
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

  test('preview-file rejects requests without workspaceId with 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-old-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')

    const response = await app.request(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)

    expect([400, 401]).toContain(response.status)
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
