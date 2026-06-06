import { describe, expect, test } from 'bun:test'
import {
  artifactFileUrl,
  artifactPreviewFileUrl,
  canFetchWorkspaceTextSource,
  downloadFileName,
  enrichPreviewItem,
  extensionFromName,
  isDocxPreviewItem,
  isPptxPreviewItem,
  isTextLikeAttachment,
  mimeFromExtension,
  normalizePreviewUrl,
  previewItemFromAgentArtifact,
  previewPathFromUrl,
  sanitizeDownloadFileName,
} from '../apps/web/src/lib/artifactPreview'

describe('artifact preview utilities', () => {
  test('normalizes preview URLs and extracts workspace file paths', () => {
    const url = normalizePreviewUrl(
      '/api/artifacts/file?workspaceId=workspace-1&path=src%2Findex.html',
      'http://127.0.0.1:5173',
    )

    expect(url?.href).toBe(
      'http://127.0.0.1:5173/api/artifacts/file?workspaceId=workspace-1&path=src%2Findex.html',
    )
    expect(previewPathFromUrl('http://127.0.0.1:5173/api/artifacts/file?path=src%2Findex.html')).toBe(
      'src/index.html',
    )
  })

  test('enriches workspace-backed HTML and file preview items with canonical URLs', () => {
    expect(
      enrichPreviewItem(
        {
          id: 'preview-1',
          kind: 'web',
          path: 'dist/index.html',
          title: 'index.html',
        },
        'workspace-1',
      ).url,
    ).toBe(artifactPreviewFileUrl('workspace-1', 'dist/index.html'))

    expect(
      enrichPreviewItem(
        {
          id: 'file-1',
          kind: 'file',
          path: 'README.md',
          title: 'README.md',
        },
        'workspace-1',
      ).url,
    ).toBe(artifactFileUrl('workspace-1', 'README.md'))

    expect(
      enrichPreviewItem(
        {
          id: 'file-legacy-url',
          kind: 'file',
          title: 'README.md',
          url: `/api/artifacts/file?path=${encodeURIComponent('README.md')}`,
        },
        'workspace-1',
      ).url,
    ).toBe(artifactFileUrl('workspace-1', 'README.md'))
  })

  test('detects text and office document preview hints', () => {
    expect(extensionFromName('README.MD')).toBe('md')
    expect(mimeFromExtension('docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(isTextLikeAttachment('application/json', 'json')).toBe(true)
    expect(
      canFetchWorkspaceTextSource(
        { id: 'readme', kind: 'file', path: 'README.md', title: 'README.md', workspaceId: 'workspace-1' },
        'README.md',
      ),
    ).toBe(true)
    expect(
      isDocxPreviewItem({
        id: 'doc',
        kind: 'file',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        title: 'brief',
      }),
    ).toBe(true)
    expect(isPptxPreviewItem({ id: 'deck', kind: 'file', path: 'slides.pptx', title: 'slides.pptx' })).toBe(
      true,
    )
  })

  test('sanitizes downloaded file names', () => {
    expect(sanitizeDownloadFileName('bad:name?.html')).toBe('bad-name-.html')
    expect(
      downloadFileName({
        id: 'image',
        kind: 'image',
        mimeType: 'image/png',
        title: 'preview',
      }),
    ).toBe('preview.png')
  })

  test('contract: maps agent artifacts into preview card items', () => {
    const labelOptions = {
      deployStatusLabel: (status: 'pending' | 'running' | 'ready' | 'failed') =>
        status === 'ready' ? 'Ready' : status,
      fileStatusLabel: (status: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked') =>
        status === 'modified' ? 'Modified' : status,
      formatBytes: (value: number) => `${value} B`,
      previewKindName: (kind: 'dev-server' | 'static-html' | 'iframe') =>
        kind === 'static-html' ? 'Static HTML' : kind,
    }

    const htmlPreview = previewItemFromAgentArtifact(
      {
        id: 'artifact-html',
        type: 'file',
        title: 'index.html',
        path: 'dist/index.html',
        status: 'created',
        mimeType: 'text/html',
        size: 2048,
      },
      labelOptions,
    )
    expect(htmlPreview).toMatchObject({
      id: 'artifact-html',
      kind: 'web',
      path: 'dist/index.html',
      title: 'index.html',
      url: `/api/artifacts/preview-file?path=${encodeURIComponent('dist/index.html')}`,
    })
    expect(enrichPreviewItem(htmlPreview, 'workspace-1').url).toBe(
      artifactPreviewFileUrl('workspace-1', 'dist/index.html'),
    )

    const staticPreview = enrichPreviewItem(
      previewItemFromAgentArtifact(
        {
          id: 'artifact-static-preview',
          type: 'preview',
          title: 'Static preview',
          url: `/api/artifacts/preview-file?path=${encodeURIComponent('dist/index.html')}`,
          previewKind: 'static-html',
        },
        labelOptions,
      ),
      'workspace-1',
    )
    expect(staticPreview).toMatchObject({
      id: 'artifact-static-preview',
      kind: 'web',
      path: 'dist/index.html',
      url: artifactPreviewFileUrl('workspace-1', 'dist/index.html'),
      workspaceId: 'workspace-1',
    })

    const externalPreview = enrichPreviewItem(
      {
        id: 'external-preview',
        kind: 'web',
        title: 'External preview',
        url: 'http://127.0.0.1:4173/?path=dist/index.html',
      },
      'workspace-1',
    )
    expect(externalPreview.path).toBeUndefined()
    expect(externalPreview.url).toBe('http://127.0.0.1:4173/?path=dist/index.html')

    const wordPreview = enrichPreviewItem(
      previewItemFromAgentArtifact(
        {
          id: 'artifact-doc',
          type: 'file',
          title: 'brief.docx',
          path: 'docs/brief.docx',
          status: 'created',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        labelOptions,
      ),
      'workspace-1',
    )
    expect(wordPreview).toMatchObject({
      id: 'artifact-doc',
      kind: 'file',
      path: 'docs/brief.docx',
      url: artifactFileUrl('workspace-1', 'docs/brief.docx'),
    })
    expect(isDocxPreviewItem(wordPreview)).toBe(true)

    const deckPreview = enrichPreviewItem(
      previewItemFromAgentArtifact(
        {
          id: 'artifact-deck',
          type: 'file',
          title: 'slides.pptx',
          path: 'slides/slides.pptx',
          status: 'created',
        },
        labelOptions,
      ),
      'workspace-1',
    )
    expect(deckPreview.url).toBe(artifactFileUrl('workspace-1', 'slides/slides.pptx'))
    expect(isPptxPreviewItem(deckPreview)).toBe(true)

    expect(
      previewItemFromAgentArtifact(
        {
          id: 'artifact-diff',
          type: 'diff',
          title: 'Patch',
          filePath: 'src/App.tsx',
          status: 'modified',
          diff: 'diff --git a/src/App.tsx b/src/App.tsx',
        },
        labelOptions,
      ),
    ).toMatchObject({
      id: 'artifact-diff',
      kind: 'diff',
      path: 'src/App.tsx',
      source: 'diff --git a/src/App.tsx b/src/App.tsx',
      subtitle: 'Modified · Diff',
    })

    expect(
      previewItemFromAgentArtifact(
        {
          id: 'artifact-deploy',
          type: 'deploy',
          title: 'Static deployment',
          provider: 'static',
          status: 'ready',
          url: 'http://127.0.0.1:8000/deploy/run-1',
        },
        labelOptions,
      ),
    ).toMatchObject({
      id: 'artifact-deploy',
      kind: 'deploy',
      subtitle: 'static · Ready',
      url: 'http://127.0.0.1:8000/deploy/run-1',
    })
  })
})
