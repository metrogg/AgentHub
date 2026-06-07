import type { AgentArtifact } from './api'

export const artifactPreviewEvent = 'agenthub:artifact-preview'
export const previewPanelWidthStorageKey = 'agenthub:preview-panel-width'
export const defaultPreviewPanelWidth = 560

export type ArtifactPreviewItem = {
  id: string
  title: string
  subtitle?: string
  description?: string
  kind: 'web' | 'file' | 'image' | 'diff' | 'deploy' | 'workflow'
  url?: string
  path?: string
  mimeType?: string
  source?: string
  /** Used to build workspace-backed HTML preview URLs. */
  workspaceId?: string
}

type FileArtifactStatus =
  | Extract<AgentArtifact, { type: 'file' }>['status']
  | Extract<AgentArtifact, { type: 'diff' }>['status']

export interface AgentArtifactPreviewOptions {
  deployStatusLabel?: (status: Extract<AgentArtifact, { type: 'deploy' }>['status']) => string
  fileStatusLabel?: (status: NonNullable<FileArtifactStatus>) => string
  formatBytes?: (value: number) => string
  previewKindName?: (kind: Extract<AgentArtifact, { type: 'preview' }>['previewKind']) => string
}

export function previewItemFromAgentArtifact(
  artifact: AgentArtifact,
  options: AgentArtifactPreviewOptions = {},
): ArtifactPreviewItem {
  if (artifact.type === 'preview') {
    return {
      id: artifact.id,
      description: artifact.description,
      kind: 'web',
      source: artifact.source,
      subtitle: options.previewKindName?.(artifact.previewKind) ?? artifact.previewKind,
      title: artifact.title,
      url: artifact.url,
      path: previewPathFromUrl(artifact.url),
    }
  }

  if (artifact.type === 'deploy') {
    const statusLabel = options.deployStatusLabel?.(artifact.status) ?? artifact.status
    return {
      id: artifact.id,
      description: artifact.description ?? artifact.logs,
      kind: 'deploy',
      source: artifact.source,
      subtitle: `${artifact.provider} · ${statusLabel}`,
      title: artifact.title,
      url: artifact.url,
      path: previewPathFromUrl(artifact.url),
    }
  }

  if (artifact.type === 'diff') {
    const status = artifact.status ?? 'modified'
    return {
      id: artifact.id,
      description: artifact.description,
      kind: 'diff',
      path: artifact.filePath,
      source: artifact.diff,
      subtitle: `${options.fileStatusLabel?.(status) ?? status} · Diff`,
      title: artifact.title || artifact.filePath,
    }
  }

  if (artifact.type === 'workflow') {
    return {
      id: artifact.id,
      description: artifact.description,
      kind: 'workflow',
      source: artifact.source,
      subtitle: `${artifact.nodes.length} nodes · ${artifact.edges.length} edges`,
      title: artifact.title,
    }
  }

  const ext = artifact.path.split('.').pop()?.toLowerCase()
  const isHtml = ext === 'html' || ext === 'htm'
  const status = artifact.status ?? 'created'
  const subtitle =
    [artifact.mimeType, artifact.size ? options.formatBytes?.(artifact.size) ?? String(artifact.size) : null]
      .filter(Boolean)
      .join(' · ') || options.fileStatusLabel?.(status) || status

  return {
    id: artifact.id,
    description: artifact.description,
    kind: isHtml ? 'web' : filePreviewKindFromAgentArtifact(artifact),
    mimeType: artifact.mimeType,
    path: artifact.path,
    source: artifact.source,
    subtitle,
    title: artifact.title || fileNameFromPath(artifact.path) || artifact.path,
    url: undefined,
  }
}

function filePreviewKindFromAgentArtifact(
  artifact: Extract<AgentArtifact, { type: 'file' }>,
): ArtifactPreviewItem['kind'] {
  if (artifact.mimeType?.startsWith('image/')) return 'image'
  return 'file'
}

export function requestArtifactPreview(item: ArtifactPreviewItem) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ArtifactPreviewItem>(artifactPreviewEvent, { detail: item }))
}

export function normalizePreviewUrl(url?: string, baseUrl = browserOrigin()) {
  if (!url) return null
  try {
    return new URL(url, baseUrl)
  } catch {
    return null
  }
}

export function previewPathFromUrl(url?: string) {
  const parsed = normalizePreviewUrl(url)
  if (!parsed) return undefined
  const path = parsed.searchParams.get('path')?.trim()
  return path || undefined
}

export function canFetchWorkspaceTextSource(item: ArtifactPreviewItem, path?: string) {
  if (!item.workspaceId || !path) return false
  const extension = extensionFromName(path)
  const mimeType = item.mimeType?.toLowerCase() || mimeFromExtension(extension) || 'text/plain'
  return isTextLikeAttachment(mimeType, extension)
}

export function enrichPreviewItem(
  item: ArtifactPreviewItem,
  workspaceId?: string,
): ArtifactPreviewItem {
  const next: ArtifactPreviewItem = {
    ...item,
    workspaceId: item.workspaceId ?? workspaceId,
  }
  if (!next.workspaceId || !next.path) return next

  if ((next.kind === 'web' || next.kind === 'deploy') && isHtmlPreviewItem(next)) {
    const url = normalizePreviewUrl(next.url)
    if (!url || url.pathname === '/api/artifacts/preview-file') {
      next.url = artifactPreviewFileUrl(next.workspaceId, next.path)
    }
    return next
  }

  if ((next.kind === 'file' || next.kind === 'image') && !next.url) {
    next.url = artifactFileUrl(next.workspaceId, next.path)
  }

  return next
}

export function artifactPreviewFileUrl(workspaceId: string, path: string) {
  return `/api/artifacts/preview-file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
}

export function artifactFileUrl(workspaceId: string, path: string) {
  return `/api/artifacts/file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
}

export function fileNameFromPath(value?: string | null) {
  if (!value) return null
  const normalized = value.replace(/\\/g, '/')
  const withoutQuery = normalized.split(/[?#]/)[0]
  return withoutQuery.split('/').filter(Boolean).pop() ?? value
}

export function previewFileName(item: ArtifactPreviewItem) {
  return fileNameFromPath(item.path) || fileNameFromPath(item.url) || item.title || 'preview'
}

export function previewFileExtension(item: ArtifactPreviewItem) {
  const fileName = previewFileName(item).split(/[?#]/)[0]
  return fileName.match(/\.([A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase() ?? ''
}

export function extensionFromName(name?: string | null) {
  const match = (name ?? '').trim().match(/\.([A-Za-z0-9]{1,12})$/)
  return match?.[1]?.toLowerCase()
}

export function mimeFromExtension(extension?: string) {
  if (!extension) return undefined
  const map: Record<string, string> = {
    bat: 'text/plain',
    cjs: 'text/javascript',
    css: 'text/css',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    htm: 'text/html',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    js: 'text/javascript',
    json: 'application/json',
    jsonl: 'application/jsonl',
    log: 'text/plain',
    markdown: 'text/markdown',
    md: 'text/markdown',
    mjs: 'text/javascript',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ps1: 'text/plain',
    py: 'text/x-python',
    scss: 'text/css',
    sh: 'text/x-shellscript',
    sql: 'application/sql',
    svg: 'image/svg+xml',
    ts: 'text/typescript',
    tsx: 'text/tsx',
    txt: 'text/plain',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
  }
  return map[extension]
}

export function isTextLikeAttachment(mimeType: string, extension?: string) {
  if (mimeType.startsWith('text/')) return true
  if (
    [
      'application/json',
      'application/jsonl',
      'application/sql',
      'application/xml',
      'application/yaml',
      'image/svg+xml',
    ].includes(mimeType)
  ) {
    return true
  }
  return Boolean(
    extension &&
      [
        'bat',
        'cjs',
        'css',
        'csv',
        'htm',
        'html',
        'js',
        'json',
        'jsonl',
        'log',
        'markdown',
        'md',
        'mjs',
        'ps1',
        'py',
        'scss',
        'sh',
        'sql',
        'svg',
        'ts',
        'tsx',
        'txt',
        'xml',
        'yaml',
        'yml',
      ].includes(extension),
  )
}

export function isDocumentLikeAttachment(mimeType: string, extension?: string) {
  return (
    mimeType === 'application/pdf' ||
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('presentationml') ||
    mimeType.includes('spreadsheetml') ||
    Boolean(extension && ['doc', 'docx', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx'].includes(extension))
  )
}

export function isHtmlPreviewItem(item: ArtifactPreviewItem) {
  if (item.kind !== 'web' && item.kind !== 'deploy') return false
  const mimeType = item.mimeType?.toLowerCase() ?? ''
  const extension = previewFileExtension(item)
  return (
    extension === 'html' ||
    extension === 'htm' ||
    extension === 'xhtml' ||
    mimeType.includes('text/html')
  )
}

export function isDocxPreviewItem(item: ArtifactPreviewItem) {
  const extension = previewFileExtension(item)
  const mimeType = item.mimeType?.toLowerCase() ?? ''
  return extension === 'docx' || mimeType.includes('wordprocessingml.document')
}

export function isPptxPreviewItem(item: ArtifactPreviewItem) {
  const extension = previewFileExtension(item)
  const mimeType = item.mimeType?.toLowerCase() ?? ''
  return extension === 'pptx' || mimeType.includes('presentationml.presentation')
}

export function officePreviewUrl(item: ArtifactPreviewItem) {
  if (item.url) return item.url
  if (item.workspaceId && item.path) return artifactFileUrl(item.workspaceId, item.path)
  return undefined
}

export async function loadPreviewArrayBuffer(item: ArtifactPreviewItem) {
  const url = officePreviewUrl(item)
  if (!url) {
    throw new Error('This file is missing a preview URL.')
  }
  const response = await fetch(url, url.startsWith('data:') ? undefined : { credentials: 'include' })
  if (!response.ok) {
    throw new Error(await extractPreviewErrorMessage(response))
  }
  return response.arrayBuffer()
}

export function downloadFileName(item: ArtifactPreviewItem) {
  const source = item.path || normalizePreviewUrl(item.url)?.pathname || item.title || 'preview'
  const rawName = source.split(/[\\/]/).filter(Boolean).pop() || item.title || 'preview'
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(rawName)
  const fallbackExtension = item.mimeType?.includes('image/')
    ? item.mimeType.split('/').pop()
    : 'html'
  const name = hasExtension ? rawName : `${rawName}.${fallbackExtension || 'html'}`
  return sanitizeDownloadFileName(name)
}

export function sanitizeDownloadFileName(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'preview.html'
  )
}

export function getPreviewPanelWidthBounds(panel: HTMLElement | null) {
  const containerWidth = panel?.parentElement?.clientWidth ?? browserInnerWidth()
  const reservedThreadWidth = Math.min(520, Math.max(300, Math.round(containerWidth * 0.34)))
  const maxWidth = Math.max(360, containerWidth - reservedThreadWidth)
  const minWidth = Math.min(360, Math.max(280, Math.round(containerWidth * 0.28)), maxWidth)
  return { maxWidth, minWidth }
}

export function clampPreviewPanelWidth(
  width: number,
  bounds: { maxWidth: number; minWidth: number },
) {
  return Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width))
}

export function readStoredPreviewPanelWidth() {
  try {
    const storedWidth = Number(window.localStorage.getItem(previewPanelWidthStorageKey))
    return Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : defaultPreviewPanelWidth
  } catch {
    return defaultPreviewPanelWidth
  }
}

export function storePreviewPanelWidth(width: number) {
  try {
    window.localStorage.setItem(previewPanelWidthStorageKey, String(Math.round(width)))
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export async function extractPreviewErrorMessage(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text.trim()) return 'HTTP ' + response.status
  try {
    const parsed = JSON.parse(text)
    const payload = parsed?.error ?? parsed
    if (typeof payload === 'string') return payload
    if (payload && typeof payload === 'object') {
      return payload.message ?? payload.details?.message ?? text
    }
  } catch {
    // ignore
  }
  return text
}

export function formatPreviewError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Preview request failed'
}

function browserOrigin() {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin
}

function browserInnerWidth() {
  return typeof window === 'undefined' ? defaultPreviewPanelWidth : window.innerWidth
}
