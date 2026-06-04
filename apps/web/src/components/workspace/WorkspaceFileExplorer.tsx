import {
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  FolderOpen,
  Globe2,
  ImagePlus,
  Loader2,
  Presentation,
  RefreshCw,
  Sheet,
} from 'lucide-react'
import { useEffect, useState, type FC } from 'react'
import {
  api,
  friendlyErrorMessage,
  type WorkspaceFileEntry,
  type WorkspaceFileListResponse,
} from '../../lib/api'
import {
  extensionFromName,
  isTextLikeAttachment,
  mimeFromExtension,
  requestArtifactPreview,
  type ArtifactPreviewItem,
} from '../../lib/artifactPreview'
import { openPath } from '../../lib/native'
import { cn, compactPath } from '../../lib/utils'
import { ArtifactPreviewSurface } from '../artifacts/ArtifactPreviewSurface'

export type WorkspaceFileExplorerWorkspace = {
  id: string
  name: string
  projectPath?: string | null
}

export type RailFileItem = ArtifactPreviewItem

export const WorkspaceFileExplorer: FC<{
  className?: string
  emptyHint?: string
  listMaxHeightClassName?: string
  previewHeightClassName?: string
  quickFiles?: RailFileItem[]
  workspace: WorkspaceFileExplorerWorkspace | null
}> = ({
  className,
  emptyHint = '选择工作区后，这里会显示项目文件。',
  listMaxHeightClassName = 'max-h-64',
  previewHeightClassName = 'h-44',
  quickFiles = [],
  workspace,
}) => {
  const [currentPath, setCurrentPath] = useState('')
  const [list, setList] = useState<WorkspaceFileListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ArtifactPreviewItem | null>(null)
  const [previewLoadingPath, setPreviewLoadingPath] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const workspacePath = workspace?.projectPath ?? null
  const workspaceId = workspace?.id ?? null

  useEffect(() => {
    setCurrentPath('')
    setList(null)
    setPreview(null)
    setError(null)
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .listWorkspaceFiles(workspaceId, currentPath)
      .then((next) => {
        if (cancelled) return
        setList(next)
      })
      .catch((err) => {
        if (cancelled) return
        setList(null)
        setError(friendlyErrorMessage(err, '读取工作区文件失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentPath, reloadToken, workspaceId])

  function openDirectory(path: string) {
    setCurrentPath(path)
    setPreview(null)
  }

  function openParent() {
    if (list?.parentPath === null) return
    setCurrentPath(list?.parentPath ?? '')
    setPreview(null)
  }

  function refresh() {
    setReloadToken((value) => value + 1)
  }

  function handleOpenEntry(entry: WorkspaceFileEntry) {
    if (entry.type === 'directory') {
      openDirectory(entry.path)
      return
    }
    void previewWorkspaceFile(entry)
  }

  async function previewWorkspaceFile(entry: WorkspaceFileEntry) {
    if (!workspaceId) return
    const mimeType = mimeFromExtension(entry.extension) || 'application/octet-stream'
    const kind = workspaceFilePreviewKind(entry, mimeType)
    const item: ArtifactPreviewItem = {
      id: `workspace-file-${workspaceId}-${entry.path}`,
      kind,
      mimeType,
      path: entry.path,
      subtitle: entry.sizeLabel,
      title: entry.name,
      workspaceId,
    }

    setPreview(item)

    if (kind !== 'file' || !isTextLikeAttachment(mimeType, entry.extension)) {
      return
    }

    setPreviewLoadingPath(entry.path)
    setError(null)
    try {
      const content = await api.readWorkspaceFile(workspaceId, entry.path)
      if (content.binary) {
        setPreview({ ...item, mimeType: content.mimeType })
        return
      }
      setPreview({
        ...item,
        description: content.truncated ? '内容较长，已截断预览。' : undefined,
        mimeType: content.mimeType,
        source: content.content,
        subtitle: content.sizeLabel,
        title: content.name,
      })
    } catch (err) {
      setError(friendlyErrorMessage(err, '读取文件失败'))
    } finally {
      setPreviewLoadingPath(null)
    }
  }

  function openSelectedFileInPreview() {
    if (!preview) return
    requestArtifactPreview(preview)
  }

  const currentLabel = list?.path
    ? compactPath(list.path) ?? list.path
    : list?.rootName ?? workspace?.name ?? '项目根目录'
  const visibleItems = list?.items ?? []

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          disabled={!workspacePath}
          onClick={() => workspacePath && void openPath(workspacePath)}
          className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-left text-xs text-neutral-700 transition hover:border-neutral-300 disabled:cursor-default disabled:text-neutral-400"
          title={workspacePath ?? workspace?.name ?? undefined}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
          <span className="truncate">{workspace?.name ?? '尚未选择工作区'}</span>
        </button>
        <button
          type="button"
          disabled={!workspaceId}
          onClick={refresh}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-900 disabled:cursor-default disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {!workspaceId ? (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-3 py-4 text-xs text-neutral-500">
          {emptyHint}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <button
              type="button"
              disabled={!list?.path}
              onClick={openParent}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-900 disabled:cursor-default disabled:opacity-40"
              title="返回上级"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1 truncate rounded-lg bg-neutral-50 px-2 py-1.5 text-neutral-500">
              {currentLabel}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-100 bg-red-50 px-2.5 py-2 text-xs leading-5 text-red-700">
              {error}
            </div>
          )}

          <div className={cn('overflow-y-auto pr-0.5', listMaxHeightClassName)}>
            <div className="space-y-1">
              {loading && !visibleItems.length ? (
                <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在读取文件...
                </div>
              ) : (
                visibleItems.map((entry) => (
                  <button
                    key={entry.path || entry.name}
                    type="button"
                    onClick={() => handleOpenEntry(entry)}
                    className={cn(
                      'group flex min-h-8 w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-neutral-50',
                      preview?.path === entry.path && 'bg-neutral-50',
                    )}
                    title={entry.path || entry.name}
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-500">
                      {entry.type === 'directory' ? (
                        <FolderOpen className="h-3.5 w-3.5" />
                      ) : (
                        workspaceFileIcon(entry, 'h-3.5 w-3.5')
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-neutral-900">
                        {entry.name}
                      </span>
                      {entry.type === 'file' && (
                        <span className="block truncate text-[11px] text-neutral-400">
                          {entry.sizeLabel}
                        </span>
                      )}
                    </span>
                    {previewLoadingPath === entry.path ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
                    ) : entry.type === 'directory' ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    ) : null}
                  </button>
                ))
              )}

              {!loading && visibleItems.length === 0 && (
                <div className="rounded-lg px-2 py-3 text-xs text-neutral-400">当前目录为空</div>
              )}
            </div>
          </div>

          {list?.truncated && (
            <div className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-4 text-amber-700">
              文件较多，仅显示前 300 项。
            </div>
          )}

          {preview && (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                <div className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-900">
                  {preview.title}
                </div>
                <button
                  type="button"
                  onClick={openSelectedFileInPreview}
                  className="text-[11px] text-neutral-500 transition hover:text-neutral-900"
                >
                  展开
                </button>
              </div>
              <div className={cn('mt-2 overflow-hidden rounded-lg border border-neutral-200 bg-white', previewHeightClassName)}>
                <ArtifactPreviewSurface item={preview} workspaceId={workspaceId ?? undefined} />
              </div>
              {preview.description && (
                <div className="mt-1 text-[11px] text-neutral-400">{preview.description}</div>
              )}
            </div>
          )}

          {quickFiles.length > 0 && (
            <div className="border-t border-neutral-100 pt-2">
              <div className="mb-1.5 text-[11px] font-medium text-neutral-400">最近产物</div>
              <div className="space-y-1">
                {quickFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => openRailFile(file)}
                    className="flex min-h-8 w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-neutral-50"
                    title={file.path ?? file.url ?? file.title}
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-500">
                      <FileText className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-900">
                      {file.title}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function workspaceFilePreviewKind(
  entry: Pick<WorkspaceFileEntry, 'name' | 'path'> & { extension?: string },
  mimeType?: string,
): ArtifactPreviewItem['kind'] {
  const extension = entry.extension ?? extensionFromName(entry.name) ?? extensionFromName(entry.path)
  const type = (mimeType || mimeFromExtension(extension) || '').toLowerCase()
  if (extension && ['html', 'htm', 'xhtml'].includes(extension)) return 'web'
  if (type.includes('text/html')) return 'web'
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(entry.name || entry.path)) {
    return 'image'
  }
  return 'file'
}

function workspaceFileIcon(entry: WorkspaceFileEntry, className = 'h-3.5 w-3.5') {
  const extension = entry.extension ?? extensionFromName(entry.name) ?? ''
  const mimeType = mimeFromExtension(extension)?.toLowerCase() ?? ''
  const lower = `${mimeType} ${entry.name}`.toLowerCase()
  if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/.test(lower)) {
    return <ImagePlus className={className} />
  }
  if (/\.(html?|xhtml)$/.test(lower) || mimeType.includes('text/html')) {
    return <Globe2 className={className} />
  }
  if (/\.(pptx?|key)$/.test(lower) || mimeType.includes('presentation')) {
    return <Presentation className={className} />
  }
  if (/\.(xlsx?|csv)$/.test(lower) || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return <Sheet className={className} />
  }
  if (isTextLikeAttachment(mimeType || 'text/plain', extension)) {
    return <FileText className={className} />
  }
  return <File className={className} />
}

function openRailFile(file: RailFileItem) {
  if (file.path && !file.workspaceId) {
    void openPath(file.path)
      .then((opened) => {
        if (!opened) requestArtifactPreview(file)
      })
      .catch(() => requestArtifactPreview(file))
    return
  }
  requestArtifactPreview(file)
}
