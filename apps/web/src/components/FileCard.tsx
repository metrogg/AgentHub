import { type FC } from 'react'
import { Download, Eye } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'

interface FileCardProps {
  fileName: string
  filePath: string
  fileSize?: number
  runId: string
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

const PREVIEWABLE_EXTS = ['html', 'htm', 'md', 'markdown', 'svg', 'txt', 'json']

function getFileIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICON_MAP[ext] ?? '📄'
}

function isPreviewable(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return PREVIEWABLE_EXTS.includes(ext)
}

function getPreviewFileType(fileName: string): 'html' | 'markdown' | 'image' | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (['svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp'].includes(ext)) return 'image'
  return null
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const FileCard: FC<FileCardProps> = ({ fileName, filePath, fileSize, runId }) => {
  const setPreviewUrl = useChatStore((s) => s.setPreviewUrl)
  const encodedName = encodeURIComponent(filePath || fileName)
  const previewSrc = `/api/artifacts/${encodeURIComponent(runId)}/${encodedName}`

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
            onClick={() => setPreviewUrl(previewSrc, getPreviewFileType(fileName), fileName)}
            className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900"
          >
            <Eye className="h-3.5 w-3.5" />
            预览
          </button>
        )}
        <a
          href={`/api/artifacts/${encodeURIComponent(runId)}/${encodedName}?download=true`}
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