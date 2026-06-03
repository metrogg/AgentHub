import { File, FileText, ImagePlus, Presentation, Sheet, X } from 'lucide-react'
import type { DragEvent, FC } from 'react'
import type { ChatAttachment } from '../../lib/api'
import {
  extensionFromName,
  isDocumentLikeAttachment,
  isTextLikeAttachment,
  mimeFromExtension,
  requestArtifactPreview,
  type ArtifactPreviewItem,
} from '../../lib/artifactPreview'
import { cn, formatBytes } from '../../lib/utils'

export const maxAttachmentBytes = 5 * 1024 * 1024
const maxAttachmentTextBytes = 256 * 1024
export const maxPendingAttachments = 6

export const attachmentInputAccept = [
  'image/*',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.xml',
  '.yaml',
  '.yml',
  '.sql',
  '.sh',
  '.bat',
  '.ps1',
  '.log',
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
].join(',')

export function isDragWithFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  const extension = extensionFromName(file.name)
  const mimeType = file.type || mimeFromExtension(extension) || 'application/octet-stream'
  const previewKind = attachmentPreviewKind(mimeType, extension)
  const dataUrl = await readFileAsDataUrl(file)
  const text =
    previewKind === 'text' ? await readFileAsTextPreview(file).catch(() => undefined) : undefined

  return {
    id: crypto.randomUUID(),
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    name: file.name || fallbackAttachmentName(mimeType, extension),
    mimeType,
    size: file.size,
    dataUrl,
    extension,
    previewKind,
    text,
  }
}

function fallbackAttachmentName(mimeType: string, extension?: string) {
  if (mimeType.startsWith('image/')) {
    const ext = extension || mimeType.split('/').pop() || 'png'
    return `pasted-image-${Date.now()}.${ext}`
  }
  return `attachment-${Date.now()}${extension ? `.${extension}` : ''}`
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

async function readFileAsTextPreview(file: File) {
  const truncated = file.size > maxAttachmentTextBytes
  const blob = truncated ? file.slice(0, maxAttachmentTextBytes) : file
  const text = await blob.text()
  return truncated ? `${text}\n\n...` : text
}

function attachmentPreviewKind(
  mimeType: string,
  extension?: string,
): NonNullable<ChatAttachment['previewKind']> {
  if (mimeType.startsWith('image/')) return 'image'
  if (isTextLikeAttachment(mimeType, extension)) return 'text'
  if (isDocumentLikeAttachment(mimeType, extension)) return 'document'
  return 'binary'
}

export function attachmentToPreviewItem(attachment: ChatAttachment): ArtifactPreviewItem {
  const isImage = attachment.type === 'image' || attachment.previewKind === 'image'
  return {
    id: attachment.id,
    kind: isImage ? 'image' : 'file',
    mimeType: attachment.mimeType,
    path: attachment.name,
    source: attachment.text,
    subtitle: `${attachmentKindLabel(attachment)} · ${formatBytes(attachment.size)}`,
    title: attachment.name,
    url: attachment.dataUrl,
  }
}

export function attachmentIcon(attachment: ChatAttachment, className = 'h-3.5 w-3.5') {
  const lower = `${attachment.mimeType} ${attachment.name}`.toLowerCase()
  if (attachment.type === 'image' || lower.includes('image/')) {
    return <ImagePlus className={className} />
  }
  if (/\.(pptx?|key)$/.test(lower) || lower.includes('presentation')) {
    return <Presentation className={className} />
  }
  if (/\.(xlsx?|csv)$/.test(lower) || lower.includes('spreadsheet') || lower.includes('excel')) {
    return <Sheet className={className} />
  }
  if (
    attachment.previewKind === 'text' ||
    /\.(md|txt|json|ts|tsx|js|py|html|css|xml|ya?ml|sql|log)$/.test(lower)
  ) {
    return <FileText className={className} />
  }
  return <File className={className} />
}

export function attachmentKindLabel(attachment: ChatAttachment) {
  if (attachment.type === 'image' || attachment.previewKind === 'image') return '图片'
  if (attachment.previewKind === 'text') return '文本'
  const lower = `${attachment.mimeType} ${attachment.name}`.toLowerCase()
  if (/\.(pptx?|key)$/.test(lower) || lower.includes('presentation')) return '演示文稿'
  if (/\.(xlsx?|csv)$/.test(lower) || lower.includes('spreadsheet') || lower.includes('excel'))
    return '表格'
  if (/\.(docx?|pdf)$/.test(lower) || attachment.previewKind === 'document') return '文档'
  return '文件'
}

export const PendingAttachmentList: FC<{
  attachments: ChatAttachment[]
  onRemove: (id: string) => void
}> = ({ attachments, onRemove }) => {
  if (!attachments.length) return null
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          role="button"
          tabIndex={0}
          onClick={() => requestArtifactPreview(attachmentToPreviewItem(attachment))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              requestArtifactPreview(attachmentToPreviewItem(attachment))
            }
          }}
          className="group relative flex h-16 max-w-full items-center gap-2 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 px-2.5 pr-8 text-left transition hover:border-neutral-300 hover:bg-white sm:w-56"
          title={attachment.name}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-neutral-200 bg-white text-neutral-500">
            {attachment.type === 'image' ? (
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              attachmentIcon(attachment, 'h-4 w-4')
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-neutral-800">
              {attachment.name}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-neutral-400">
              {attachmentKindLabel(attachment)} · {formatBytes(attachment.size)}
            </span>
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onRemove(attachment.id)
            }}
            className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full text-neutral-400 opacity-80 transition hover:bg-neutral-200 hover:text-neutral-900"
            aria-label={`移除 ${attachment.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

export const ChatAttachmentsPart: FC<{ data: { items?: ChatAttachment[] } }> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return null
  return (
    <div className="not-prose mt-3 grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => requestArtifactPreview(attachmentToPreviewItem(item))}
          className={cn(
            'group overflow-hidden rounded-xl border border-neutral-200 bg-white text-left shadow-sm transition hover:border-neutral-300 hover:shadow-md',
            item.type === 'image' ? 'block' : 'flex min-h-20 items-center gap-3 px-3 py-3',
          )}
        >
          {item.type === 'image' ? (
            <>
              <img
                src={item.dataUrl}
                alt={item.name}
                className="aspect-video w-full bg-neutral-100 object-cover transition group-hover:scale-[1.015]"
                draggable={false}
              />
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500">
                <ImagePlus className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0">{formatBytes(item.size)}</span>
              </div>
            </>
          ) : (
            <>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500">
                {attachmentIcon(item, 'h-5 w-5')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-neutral-900">
                  {item.name}
                </span>
                <span className="mt-1 block truncate text-xs text-neutral-500">
                  {attachmentKindLabel(item)} · {formatBytes(item.size)}
                </span>
                {item.text && (
                  <span className="mt-1 block truncate text-[11px] text-neutral-400">
                    可预览文本内容
                  </span>
                )}
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}
