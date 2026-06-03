import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from '../apps/server/src/app'
import { previewDirectoryUrl } from '../apps/server/src/services/artifact-preview'

describe('artifact static preview', () => {
  test('serves an html file and its relative assets from the same preview directory route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), '<link rel="stylesheet" href="./assets/app.css"><div id="app"></div>')
    writeFileSync(join(root, 'assets', 'app.css'), '#app { background: black; }')

    const url = previewDirectoryUrl(join(root, 'index.html'))
    const html = await app.request(url)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('assets/app.css')

    const assetUrl = url.replace(/index\.html$/, 'assets/app.css')
    const asset = await app.request(assetUrl)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('background: black')
  })

  test('keeps old preview-file links working — serves the html file directly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-preview-old-'))
    const filePath = join(root, 'index.html')
    writeFileSync(filePath, '<div>ok</div>')

    const response = await app.request(`/api/artifacts/preview-file?path=${encodeURIComponent(filePath)}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<div>ok</div>')
    expect(existsSync(filePath)).toBe(true)
  })
})
