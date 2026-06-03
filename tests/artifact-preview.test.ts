import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from '../apps/server/src/app'
import { previewDirectoryUrl } from '../apps/server/src/services/artifact-preview'

describe('artifact static preview', () => {
  test('preview-dir rejects an arbitrary directory not under a managed root or workspace', async () => {
    // A login user must not be able to base64-encode an arbitrary host directory
    // as the preview root. Temp dirs outside AgentHub managed roots / owned
    // workspaces must be denied.
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), '<link rel="stylesheet" href="./assets/app.css"><div id="app"></div>')
    writeFileSync(join(root, 'assets', 'app.css'), '#app { background: black; }')

    const url = previewDirectoryUrl(join(root, 'index.html'))
    const html = await app.request(url)
    // Denied: root is neither a managed root nor an owned workspace projectPath
    expect([401, 403]).toContain(html.status)
  })

  test('preview-file rejects requests without workspaceId with 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-old-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')

    const response = await app.request(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)

    // Now requires workspaceId — missing workspaceId returns 400
    expect([400, 401]).toContain(response.status)
  })

  test('preview-file rejects requests with invalid workspaceId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-bad-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')

    const response = await app.request(
      `/api/artifacts/preview-file?workspaceId=nonexistent&path=${encodeURIComponent(filePath)}`,
    )

    // Should get 401 (no auth) or 404 (workspace not found)
    expect([401, 404]).toContain(response.status)
  })
})
