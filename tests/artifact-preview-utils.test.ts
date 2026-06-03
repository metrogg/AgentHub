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
})
