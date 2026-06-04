import { type FC } from 'react'
import { Download, Eye } from 'lucide-react'
import {
  artifactFileUrl,
  artifactPreviewFileUrl,
  extensionFromName,
  mimeFromExtension,
  requestArtifactPreview,
  type ArtifactPreviewItem,
} from '@/lib/artifactPreview'

interface FileCardProps {
  fileName: string
  filePath: string
  fileSize?: number
  runId: string
  workspaceId?: string
}

const FILE_ICON_MAP: Record<string, string> = {
  html: '🌐',
  htm: '🌐',
  js: '📜',
  mjs: '📜',
  jsx: '📜',
  ts: '📜',
  tsx: '📜',
  css: '🎨',
  scss: '🎨',
  less: '🎨',
  py: '🐍',
  md: '📝',
  markdown: '📝',
  json: '📋',
  svg: '🖼️',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  ico: '🖼️',
  pdf: '📕',
  zip: '📦',
  txt: '📄',
  yml: '⚙️',
  yaml: '⚙️',
  toml: '⚙️',
}

const PREVIEWABLE_EXTS = [
  'docx',
  'html',
  'htm',
  'json',
  'markdown',
  'md',
  'pptx',
  'svg',
  'txt',
]

function getFileIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICON_MAP[ext] ?? '📄'
}

function isPreviewable(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return PREVIEWABLE_EXTS.includes(ext)
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function previewKind(fileName: string): ArtifactPreviewItem['kind'] {
  const ext = extensionFromName(fileName) ?? ''
  if (ext === 'html' || ext === 'htm') return 'web'
  if (['svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp'].includes(ext)) return 'image'
  return 'file'
}

export const FileCard: FC<FileCardProps> = ({
  fileName,
  filePath,
  fileSize,
  runId,
  workspaceId,
}) => {
  const path = filePath || fileName
  const encodedName = encodeURIComponent(path)
  const legacyFileUrl = `/api/artifacts/${encodeURIComponent(runId)}/${encodedName}`
  const fileUrl = workspaceId ? artifactFileUrl(workspaceId, path) : legacyFileUrl
  const ext = extensionFromName(fileName) ?? extensionFromName(path) ?? ''
  const kind = previewKind(fileName || path)
  const previewUrl =
    workspaceId && kind === 'web' ? artifactPreviewFileUrl(workspaceId, path) : fileUrl

  function openPreview() {
    requestArtifactPreview({
      id: `file-card-${runId}-${path}`,
      kind,
      mimeType: mimeFromExtension(ext),
      path,
      title: fileName,
      url: previewUrl,
      workspaceId,
    })
  }

  return (
    <div className="not-prose my-2 flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm transition hover:shadow-md">
      <span className="text-2xl leading-none" aria-hidden="true">
        {getFileIcon(fileName)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-neutral-900">{fileName}</p>
        <p className="text-xs text-neutral-400">
          {formatFileSize(fileSize)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isPreviewable(fileName) && (
          <button
            type="button"
            onClick={openPreview}
            className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900"
          >
            <Eye className="h-3.5 w-3.5" />
            预览
          </button>
        )}
        <a
          href={workspaceId ? fileUrl : `${legacyFileUrl}?download=true`}
          download={fileName}
          className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900"
        >
          <Download className="h-3.5 w-3.5" />
          下载
        </a>
      </div>
    </div>
  )
}

export default FileCard
