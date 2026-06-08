import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diffLanguage from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import {
  AlertTriangle,
  ArrowUp,
  File,
  FileText,
  GitBranch,
  Loader2,
  Presentation,
  RefreshCw,
  TextQuote,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { friendlyErrorMessage } from '../../lib/api'
import {
  artifactFileUrl,
  canFetchWorkspaceTextSource,
  enrichPreviewItem,
  extractPreviewErrorMessage,
  formatPreviewError,
  hasInlinePreviewSource,
  inlinePreviewSource,
  isDocxPreviewItem,
  isPdfPreviewItem,
  isPptxPreviewItem,
  loadPreviewArrayBuffer,
  normalizePreviewUrl,
  officePreviewUrl,
  previewFileName,
  previewPathFromUrl,
  type ArtifactPreviewItem,
} from '../../lib/artifactPreview'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chatStore'
import LineSelectionToolbar from '../assistant-ui/LineSelectionToolbar'
import { useLineSelection } from '../assistant-ui/useLineSelection'

const previewHighlightLanguages = {
  bash,
  css,
  diff: diffLanguage,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
}

Object.entries(previewHighlightLanguages).forEach(([name, syntax]) => {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, syntax)
})

const autoHighlightLanguages = Object.keys(previewHighlightLanguages)
const composerSyncEvent = 'agenthub:composer-sync'

export type ArtifactPreviewMode = 'preview' | 'source'

export type DiffEditSaveParams = {
  lineText: string
  lineNumber?: number
  fileContent?: string
}

type LocalChangeTarget = {
  filePath?: string
  language?: string
  lineLabel: string
  selectedText: string
  sourceLabel: string
}

type ArtifactPreviewSurfaceProps = {
  className?: string
  item: ArtifactPreviewItem
  onSaveDiffEdit?: (params: DiffEditSaveParams) => void | Promise<void>
  viewMode?: ArtifactPreviewMode
  workspaceId?: string
}

export function canInspectArtifactPreviewSource(
  item: ArtifactPreviewItem,
  workspaceId?: string,
) {
  const enriched = enrichPreviewItem(item, workspaceId)
  const sourcePath = enriched.path ?? previewPathFromUrl(enriched.url) ?? undefined
  return hasInlinePreviewSource(enriched) || canFetchWorkspaceTextSource(enriched, sourcePath)
}

export const ArtifactPreviewSurface: FC<ArtifactPreviewSurfaceProps> = ({
  className,
  item,
  onSaveDiffEdit,
  viewMode = 'preview',
  workspaceId,
}) => {
  const enrichedItem = useMemo(
    () => enrichPreviewItem(item, workspaceId),
    [item, workspaceId],
  )
  const runnablePreview =
    (enrichedItem.kind === 'web' || enrichedItem.kind === 'deploy') && Boolean(enrichedItem.url)
  const inspectSource = canInspectArtifactPreviewSource(enrichedItem, workspaceId)
  const showSource = viewMode === 'source' && inspectSource
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    runnablePreview ? 'loading' : 'ready',
  )
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const previewUrl = useMemo(() => normalizePreviewUrl(enrichedItem.url), [enrichedItem.url])

  useEffect(() => {
    if (!enrichedItem.url || !runnablePreview || showSource) {
      setLoadingState('ready')
      setLoadError('')
      return
    }

    let cancelled = false
    setLoadingState('loading')
    setLoadError('')

    async function probePreview() {
      if (!previewUrl || previewUrl.origin !== window.location.origin) {
        if (!cancelled) setLoadingState('ready')
        return
      }

      try {
        const response = await fetch(previewUrl.href, { credentials: 'include' })
        if (cancelled) return
        if (!response.ok) throw new Error(await extractPreviewErrorMessage(response))
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          throw new Error(await extractPreviewErrorMessage(response))
        }
        setLoadingState('ready')
      } catch (error) {
        if (cancelled) return
        setLoadingState('error')
        setLoadError(formatPreviewError(error))
      }
    }

    void probePreview()
    return () => {
      cancelled = true
    }
  }, [enrichedItem.url, previewUrl, reloadToken, runnablePreview, showSource])

  return (
    <div className={cn('h-full min-h-0 overflow-hidden bg-white', className)}>
      {enrichedItem.kind === 'image' && enrichedItem.url ? (
        <div className="grid h-full place-items-center bg-neutral-950 p-4">
          <img
            src={enrichedItem.url}
            alt={enrichedItem.title}
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
            decoding="async"
            draggable={false}
          />
        </div>
      ) : runnablePreview && showSource ? (
        <TextFilePreview item={enrichedItem} />
      ) : runnablePreview && enrichedItem.url ? (
        loadingState === 'error' ? (
          <PreviewErrorState
            title={enrichedItem.title}
            error={loadError}
            onRetry={() => setReloadToken((value) => value + 1)}
          />
        ) : loadingState !== 'ready' ? (
          <PreviewLoadingState item={enrichedItem} />
        ) : (
          <iframe
            title={enrichedItem.title}
            src={enrichedItem.url}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )
      ) : enrichedItem.kind === 'diff' ? (
        <div className="h-full overflow-auto">
          <ArtifactDiffViewer
            diff={enrichedItem.source ?? ''}
            filePath={enrichedItem.path}
            maxHeightClassName="max-h-none"
            onSaveEdit={onSaveDiffEdit}
          />
        </div>
      ) : enrichedItem.kind === 'workflow' ? (
        <WorkflowPreviewPlaceholder item={enrichedItem} />
      ) : isDocxPreviewItem(enrichedItem) ? (
        <WordDocumentPreview item={enrichedItem} />
      ) : isPptxPreviewItem(enrichedItem) ? (
        <PresentationDocumentPreview item={enrichedItem} />
      ) : isPdfPreviewItem(enrichedItem) ? (
        <PdfDocumentPreview item={enrichedItem} />
      ) : hasInlinePreviewSource(enrichedItem) || canInspectArtifactPreviewSource(enrichedItem, workspaceId) ? (
        <TextFilePreview item={enrichedItem} />
      ) : (
        <DocumentPreviewPlaceholder item={enrichedItem} />
      )}
    </div>
  )
}

const PreviewLoadingState: FC<{ item: ArtifactPreviewItem }> = ({ item }) => (
  <div className="grid h-full place-items-center bg-[#f8fafc] p-6">
    <div className="w-full max-w-md rounded-[22px] border border-neutral-200 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-neutral-100 bg-neutral-50 text-neutral-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
      <div className="mt-4 text-sm font-semibold text-neutral-950">Loading preview</div>
      <div className="mt-2 text-xs leading-5 text-neutral-500">
        {item.subtitle ?? previewKindLabel(item)}
      </div>
    </div>
  </div>
)

const PreviewErrorState: FC<{ error: string; onRetry: () => void; title: string }> = ({
  error,
  onRetry,
  title,
}) => (
  <div className="grid h-full place-items-center bg-[#f8fafc] p-6">
    <div className="w-full max-w-lg rounded-[22px] border border-red-100 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-red-100 bg-red-50 text-red-500">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="mt-4 text-sm font-semibold text-neutral-950">Preview failed</div>
      <div className="mt-2 text-xs leading-6 text-neutral-500">{title}</div>
      <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-left text-xs leading-6 text-red-700">
        {error || 'The preview service returned an error response.'}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800"
      >
        <RefreshCw className="h-4 w-4" />
        Retry
      </button>
    </div>
  </div>
)

const WordDocumentPreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const styleRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const bodyEl = bodyRef.current
    const styleEl = styleRef.current
    if (!bodyEl || !styleEl) return
    const bodyContainer: HTMLElement = bodyEl
    const styleContainer: HTMLElement = styleEl

    let cancelled = false
    bodyContainer.innerHTML = ''
    styleContainer.innerHTML = ''
    setStatus('loading')
    setError('')

    async function renderDocument() {
      const [{ renderAsync }, data] = await Promise.all([
        import('docx-preview'),
        loadPreviewArrayBuffer(item),
      ])
      if (cancelled) return
      await renderAsync(data, bodyContainer, styleContainer, {
        breakPages: true,
        className: 'agenthub-docx',
        ignoreFonts: false,
        inWrapper: true,
        renderFooters: true,
        renderHeaders: true,
        useBase64URL: true,
      })
      if (!cancelled) setStatus('ready')
    }

    void renderDocument().catch((err) => {
      if (cancelled) return
      setStatus('error')
      setError(formatPreviewError(err))
    })

    return () => {
      cancelled = true
      bodyContainer.innerHTML = ''
      styleContainer.innerHTML = ''
    }
  }, [item.id, item.path, item.url, item.workspaceId, reloadToken])

  if (status === 'error') {
    return (
      <PreviewErrorState
        title={item.title}
        error={error}
        onRetry={() => setReloadToken((value) => value + 1)}
      />
    )
  }

  return (
    <div className="agenthub-office-preview flex h-full flex-col bg-[#f6f7f9]">
      <OfficePreviewHeader item={item} label="Word" />
      <div className="relative min-h-0 flex-1 overflow-auto">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10">
            <PreviewLoadingState item={item} />
          </div>
        )}
        <div className="agenthub-docx-host">
          <div ref={styleRef} />
          <div ref={bodyRef} />
        </div>
      </div>
    </div>
  )
}

const PresentationDocumentPreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [renderWidth, setRenderWidth] = useState(900)

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return

    const updateWidth = () => {
      const nextWidth = Math.max(320, Math.min(1120, Math.floor(scrollEl.clientWidth - 32)))
      setRenderWidth((current) => (Math.abs(current - nextWidth) > 24 ? nextWidth : current))
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(scrollEl)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl) return
    const hostContainer: HTMLElement = hostEl

    let cancelled = false
    let previewer: { destroy?: () => void } | null = null
    hostContainer.innerHTML = ''
    setStatus('loading')
    setError('')

    async function renderPresentation() {
      const [{ init }, data] = await Promise.all([
        import('pptx-preview'),
        loadPreviewArrayBuffer(item),
      ])
      if (cancelled) return
      const width = Math.max(320, Math.floor(renderWidth))
      const height = Math.round(width * 0.5625)
      const nextPreviewer = init(hostContainer, { height, mode: 'list', width })
      previewer = nextPreviewer
      await nextPreviewer.preview(data)
      if (!cancelled) setStatus('ready')
    }

    void renderPresentation().catch((err) => {
      if (cancelled) return
      setStatus('error')
      setError(formatPreviewError(err))
    })

    return () => {
      cancelled = true
      previewer?.destroy?.()
      hostContainer.innerHTML = ''
    }
  }, [item.id, item.path, item.url, item.workspaceId, reloadToken, renderWidth])

  if (status === 'error') {
    return (
      <PreviewErrorState
        title={item.title}
        error={error}
        onRetry={() => setReloadToken((value) => value + 1)}
      />
    )
  }

  return (
    <div className="agenthub-office-preview flex h-full flex-col bg-[#f6f7f9]">
      <OfficePreviewHeader item={item} label="PowerPoint" />
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10">
            <PreviewLoadingState item={item} />
          </div>
        )}
        <div className="agenthub-pptx-host">
          <div ref={hostRef} />
        </div>
      </div>
    </div>
  )
}

const PdfDocumentPreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const url = officePreviewUrl(item)
  if (!url) return <DocumentPreviewPlaceholder item={item} />

  return (
    <div className="agenthub-office-preview flex h-full flex-col bg-[#f6f7f9]">
      <OfficePreviewHeader item={item} label="PDF" />
      <iframe
        title={item.title}
        src={url}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  )
}

const OfficePreviewHeader: FC<{ item: ArtifactPreviewItem; label: string }> = ({
  item,
  label,
}) => (
  <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 text-xs text-neutral-500">
    {isPptxPreviewItem(item) ? (
      <Presentation className="h-4 w-4 text-neutral-400" />
    ) : (
      <FileText className="h-4 w-4 text-neutral-400" />
    )}
    <span className="min-w-0 flex-1 truncate">{previewFileName(item)}</span>
    <span className="rounded-md bg-[#f6f7f9] px-2 py-1">{label}</span>
  </div>
)

const DocumentPreviewPlaceholder: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const fileName = item.path ?? item.title
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 bg-[#f5f5f1] px-3 text-xs text-neutral-500">
        <FileText className="h-4 w-4 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate">{fileName}</span>
        <span className="rounded-md bg-[#F7F7F7] px-2 py-1">read only</span>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center bg-[#F7F7F7] p-8">
        <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[#F7F7F7] text-neutral-500">
            <File className="h-8 w-8" />
          </div>
          <div className="mt-4 truncate text-sm font-semibold text-neutral-950">{item.title}</div>
          <div className="mt-2 text-xs leading-5 text-neutral-500">{previewFileHint(item)}</div>
          {item.path && (
            <div className="agenthub-readable-code mt-4 rounded-xl bg-[#F7F7F7] px-3 py-2 text-left text-xs leading-5 text-neutral-500">
              {item.path}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const WorkflowPreviewPlaceholder: FC<{ item: ArtifactPreviewItem }> = ({ item }) => (
  <div className="grid h-full place-items-center bg-[#F7F7F7] p-8">
    <div className="max-w-md rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[#F7F7F7] text-neutral-500">
        <GitBranch className="h-8 w-8" />
      </div>
      <div className="mt-4 text-sm font-semibold text-neutral-950">{item.title}</div>
      <div className="mt-2 text-xs leading-5 text-neutral-500">
        {item.description ?? 'This artifact currently exposes structured summary metadata.'}
      </div>
    </div>
  </div>
)

const TextFilePreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const resolvedPath = item.path ?? previewPathFromUrl(item.url) ?? undefined
  const fileName = resolvedPath ?? item.title
  const language = guessLanguageFromPath(fileName) || 'text'
  const canLoadWorkspaceSource = canFetchWorkspaceTextSource(item, resolvedPath)
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const [sourceLoadState, setSourceLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  )
  const [sourceLoadError, setSourceLoadError] = useState('')
  const source = loadedSource ?? inlinePreviewSource(item.source) ?? ''
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n'), [source])
  const highlightedLines = useMemo(
    () => lines.map((line) => highlightCode(line, language)),
    [lines, language],
  )
  const selection = useLineSelection(lines.length)
  const [localChangeTarget, setLocalChangeTarget] = useState<LocalChangeTarget | null>(null)

  useEffect(() => {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }, [source, selection.clearSelection])

  useEffect(() => {
    setLoadedSource(null)
    setSourceLoadError('')
    setSourceLoadState('idle')
    if (!canLoadWorkspaceSource || !item.workspaceId || !resolvedPath) return

    const controller = new AbortController()
    setSourceLoadState('loading')

    fetch(artifactFileUrl(item.workspaceId, resolvedPath), {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await extractPreviewErrorMessage(response))
        return response.text()
      })
      .then((text) => {
        setLoadedSource(text)
        setSourceLoadState('ready')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setSourceLoadState('error')
        setSourceLoadError(formatPreviewError(error))
      })

    return () => controller.abort()
  }, [canLoadWorkspaceSource, item.id, item.workspaceId, resolvedPath])

  function buildTextFileTarget(): LocalChangeTarget | null {
    const selected = selection.sortedSelected
    if (selected.length === 0) return null
    const selectedLines = selected.map((index) => lines[index])
    return {
      filePath: resolvedPath,
      language,
      lineLabel: formatLineRangeLabel(selected[0] + 1, selected[selected.length - 1] + 1),
      selectedText: selectedLines.join('\n'),
      sourceLabel: 'file preview',
    }
  }

  function handleReference() {
    const target = buildTextFileTarget()
    if (!target) return
    const header = target.filePath
      ? `\`${target.filePath}\` ${target.lineLabel}:\n`
      : `${target.lineLabel}:\n`
    insertTextIntoComposer(`${header}${codeFenceForContent(target.selectedText, language)}\n`)
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  function handleLocalChange() {
    const target = buildTextFileTarget()
    if (target) setLocalChangeTarget(target)
  }

  function clearTextSelection() {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 bg-[#f5f5f1] px-3 text-xs text-neutral-500">
        <FileText className="h-4 w-4 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate">{fileName}</span>
        <span className="rounded-md bg-[#F7F7F7] px-2 py-1">{language}</span>
        {sourceLoadState === 'loading' && (
          <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-blue-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            loading source
          </span>
        )}
        {sourceLoadState === 'error' && (
          <span
            className="max-w-[12rem] truncate rounded-md bg-amber-50 px-2 py-1 text-amber-700"
            title={sourceLoadError}
          >
            using cached source
          </span>
        )}
      </div>
      <div className="agenthub-file-code-preview min-h-0 flex-1 overflow-auto bg-[#0f172a]">
        {selection.selectedCount > 0 && (
          <LineSelectionToolbar
            selectedCount={selection.selectedCount}
            onReference={handleReference}
            onLocalChange={handleLocalChange}
            onClear={clearTextSelection}
          />
        )}
        {localChangeTarget && (
          <LocalChangeComposer
            target={localChangeTarget}
            onCancel={() => setLocalChangeTarget(null)}
            onSent={clearTextSelection}
          />
        )}
        <pre className="agenthub-code-pre agenthub-file-code-pre not-prose">
          <code className={cn('agenthub-code', `language-${language}`)}>
            <table className="agenthub-code-table">
              <tbody>
                {lines.map((_line, index) => (
                  <tr
                    key={index}
                    className={selection.isSelected(index) ? 'agenthub-code-row-selected' : undefined}
                  >
                    <td
                      className="agenthub-code-ln"
                      onClick={(event) => selection.toggleLine(index, event.shiftKey)}
                    >
                      {index + 1}
                    </td>
                    <td
                      className="agenthub-code-content"
                      onClick={(event) => {
                        if (shouldSkipLineSelectionClick(event)) return
                        selection.toggleLine(index, event.shiftKey)
                      }}
                    >
                      <span dangerouslySetInnerHTML={{ __html: highlightedLines[index] || '&nbsp;' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </code>
        </pre>
      </div>
    </div>
  )
}

export const ArtifactDiffViewer: FC<{
  diff: string
  maxHeightClassName?: string
  filePath?: string
  onSaveEdit?: (params: DiffEditSaveParams) => void | Promise<void>
}> = ({
  diff,
  maxHeightClassName = 'max-h-96',
  filePath,
  onSaveEdit,
}) => {
  const parsedRows = useMemo(() => parseDiffRows(diff), [diff])
  const [rowTextOverrides, setRowTextOverrides] = useState<Record<number, string>>({})
  const rows = useMemo(
    () =>
      parsedRows.map((row, index) =>
        Object.prototype.hasOwnProperty.call(rowTextOverrides, index)
          ? { ...row, text: rowTextOverrides[index] }
          : row,
      ),
    [parsedRows, rowTextOverrides],
  )
  const selectableRows = useMemo(
    () =>
      rows
        .map((row, index) => ({ ...row, _index: index }))
        .filter((row) => row.kind === 'add' || row.kind === 'del' || row.kind === 'context'),
    [rows],
  )
  const selection = useLineSelection(selectableRows.length)
  const [editingSelectableIndex, setEditingSelectableIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [editSaveNotice, setEditSaveNotice] = useState<{
    tone: 'success' | 'error'
    message: string
  } | null>(null)
  const [localChangeTarget, setLocalChangeTarget] = useState<LocalChangeTarget | null>(null)

  useEffect(() => {
    setRowTextOverrides({})
    setEditSaveNotice(null)
    setEditingSelectableIndex(null)
    setEditDraft('')
  }, [diff])

  function isRowSelected(originalIndex: number) {
    const selectableIndex = selectableRows.findIndex((row) => row._index === originalIndex)
    return selectableIndex >= 0 && selection.isSelected(selectableIndex)
  }

  function handleLineNumberClick(originalIndex: number, shiftKey: boolean) {
    const selectableIndex = selectableRows.findIndex((row) => row._index === originalIndex)
    if (selectableIndex >= 0) selection.toggleLine(selectableIndex, shiftKey)
  }

  function handleDiffCodeClick(
    originalIndex: number,
    event: ReactMouseEvent<HTMLElement>,
  ) {
    if (window.getSelection()?.toString()) return
    handleLineNumberClick(originalIndex, event.shiftKey)
  }

  function buildDiffTarget(): LocalChangeTarget | null {
    const selected = selection.sortedSelected.map((index) => selectableRows[index])
    if (selected.length === 0) return null
    const selectedLines = selected.map((row) => {
      const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
      return `${marker}${row.text}`
    })
    const startLine = selected[0].newNumber ?? selected[0].oldNumber ?? '?'
    const endLine =
      selected[selected.length - 1].newNumber ?? selected[selected.length - 1].oldNumber ?? startLine
    return {
      filePath,
      language: filePath ? guessLanguageFromPath(filePath) : 'diff',
      lineLabel: formatLineRangeLabel(startLine, endLine),
      selectedText: selectedLines.join('\n'),
      sourceLabel: 'diff preview',
    }
  }

  function buildReferenceText() {
    const target = buildDiffTarget()
    if (!target) return ''
    const language = filePath ? guessLanguageFromPath(filePath) : ''
    const header = filePath ? `\`${filePath}\` ${target.lineLabel}:\n` : `${target.lineLabel}:\n`
    return `${header}${codeFenceForContent(target.selectedText, language)}\n`
  }

  function handleReference() {
    const text = buildReferenceText()
    if (text) insertTextIntoComposer(text)
    clearDiffSelection()
  }

  function handleLocalChange() {
    const target = buildDiffTarget()
    if (target) setLocalChangeTarget(target)
  }

  function clearDiffSelection() {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  function handleStartEdit() {
    if (selection.sortedSelected.length === 0) return
    const firstSelectedIndex = selection.sortedSelected[0]
    setEditingSelectableIndex(firstSelectedIndex)
    setEditSaveNotice(null)
    const row = selectableRows[firstSelectedIndex]
    const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
    setEditDraft(`${marker}${row.text}`)
  }

  function handleCancelEdit() {
    setEditingSelectableIndex(null)
    setEditDraft('')
    setEditSaveNotice(null)
  }

  async function handleSaveEdit() {
    if (editingSelectableIndex === null || !onSaveEdit) return
    setSaving(true)
    setEditSaveNotice(null)
    try {
      const row = selectableRows[editingSelectableIndex]
      const lineNumber = row.kind === 'del' ? row.oldNumber : row.newNumber
      if (!lineNumber) {
        setEditSaveNotice({
          tone: 'error',
          message: 'This diff row does not include a writable line number.',
        })
        return
      }
      const lineText = editDraft.length > 1 ? editDraft.slice(1) : ''
      await onSaveEdit({
        lineText,
        lineNumber,
        fileContent: buildEditableDiffFileContent(rows, row._index, lineText),
      })
      setRowTextOverrides((current) => ({ ...current, [row._index]: lineText }))
      setEditSaveNotice({ tone: 'success', message: 'Saved to workspace file.' })
      setEditingSelectableIndex(null)
      setEditDraft('')
      clearDiffSelection()
    } catch (error) {
      setEditSaveNotice({
        tone: 'error',
        message: friendlyErrorMessage(error, 'Save failed'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agenthub-diff-container">
      {selection.selectedCount > 0 && (
        <LineSelectionToolbar
          selectedCount={selection.selectedCount}
          onReference={handleReference}
          onLocalChange={handleLocalChange}
          onEdit={onSaveEdit ? handleStartEdit : undefined}
          onClear={clearDiffSelection}
        />
      )}
      {localChangeTarget && (
        <LocalChangeComposer
          target={localChangeTarget}
          onCancel={() => setLocalChangeTarget(null)}
          onSent={clearDiffSelection}
        />
      )}
      {editSaveNotice && (
        <div
          className={cn(
            'border-t px-3 py-2 text-xs',
            editSaveNotice.tone === 'error'
              ? 'border-red-100 bg-red-50 text-red-700'
              : 'border-emerald-100 bg-emerald-50 text-emerald-700',
          )}
        >
          {editSaveNotice.message}
        </div>
      )}
      <div
        className={cn(
          'overflow-auto border-t border-neutral-200 bg-white text-[13px]',
          maxHeightClassName,
          selection.selectedCount > 0 && 'border-t-0',
        )}
      >
        <div className="agenthub-readable-code min-w-max py-1 leading-7">
          {rows.map((row, index) => {
            const selected = isRowSelected(index)
            const isEditing =
              selectableRows.findIndex((candidate) => candidate._index === index) ===
              editingSelectableIndex
            const canSelect =
              row.kind === 'add' || row.kind === 'del' || row.kind === 'context'

            return (
              <div
                key={`${index}-${row.text}`}
                className={cn(
                  'grid grid-cols-[3.25rem_3.25rem_minmax(32rem,1fr)] border-l-4 pr-4',
                  row.kind === 'add' && 'border-emerald-500 bg-emerald-50 text-emerald-950',
                  row.kind === 'del' && 'border-red-500 bg-red-50 text-red-950',
                  row.kind === 'hunk' && 'border-blue-300 bg-blue-50 text-blue-700',
                  row.kind === 'meta' && 'border-transparent bg-neutral-50 text-neutral-500',
                  row.kind === 'context' && 'border-transparent text-neutral-800',
                  selected && 'agenthub-diff-row-selected',
                )}
              >
                <span
                  className={cn(
                    'select-none border-r border-neutral-100 px-2 text-right text-neutral-400',
                    row.kind === 'add' && 'text-emerald-600',
                    row.kind === 'del' && 'text-red-600',
                    canSelect && 'agenthub-diff-line-number',
                  )}
                  onClick={canSelect ? (event) => handleLineNumberClick(index, event.shiftKey) : undefined}
                >
                  {row.oldNumber ?? ''}
                </span>
                <span
                  className={cn(
                    'select-none border-r border-neutral-100 px-2 text-right text-neutral-400',
                    row.kind === 'add' && 'text-emerald-600',
                    row.kind === 'del' && 'text-red-600',
                    canSelect && 'agenthub-diff-line-number',
                  )}
                  onClick={canSelect ? (event) => handleLineNumberClick(index, event.shiftKey) : undefined}
                >
                  {row.newNumber ?? ''}
                </span>
                {isEditing ? (
                  <div className="flex flex-col px-1 py-0.5">
                    <textarea
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      className="agenthub-inline-edit"
                      autoFocus
                      rows={1}
                    />
                    <div className="agenthub-inline-edit-actions">
                      <button
                        type="button"
                        className="agenthub-inline-edit-btn agenthub-inline-edit-btn-save"
                        onClick={handleSaveEdit}
                        disabled={saving}
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="agenthub-inline-edit-btn agenthub-inline-edit-btn-cancel"
                        onClick={handleCancelEdit}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <code
                    className={cn('whitespace-pre px-3', canSelect && 'agenthub-diff-code-selectable')}
                    onClick={canSelect ? (event) => handleDiffCodeClick(index, event) : undefined}
                  >
                    <span
                      className={cn(
                        'mr-2 inline-block w-3 select-none',
                        row.kind === 'add' && 'text-emerald-600',
                        row.kind === 'del' && 'text-red-600',
                      )}
                    >
                      {row.marker}
                    </span>
                    {row.text}
                  </code>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const LocalChangeComposer: FC<{
  target: LocalChangeTarget
  onCancel: () => void
  onSent: () => void
  className?: string
}> = ({ target, onCancel, onSent, className }) => {
  const sendMessage = useChatStore((state) => state.sendMessage)
  const safetyMode = useChatStore((state) => state.safetyMode)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const targetSignature = `${target.filePath ?? ''}|${target.lineLabel}|${target.sourceLabel}|${target.selectedText}`
  const running = agentTyping || Boolean(streamingMessage)
  const disabledReason = !currentSessionId
    ? 'Select a chat first.'
    : running
      ? 'Agent is still responding.'
      : ''

  useEffect(() => {
    setDraft('')
    setError('')
  }, [targetSignature])

  async function submitLocalChange() {
    const instruction = draft.trim()
    if (!instruction || submitting || disabledReason) return
    setSubmitting(true)
    setError('')
    try {
      await sendMessage(buildLocalChangePrompt(target, instruction), {
        displayContent: buildLocalChangeDisplay(target, instruction),
        safetyMode,
        usePendingAttachments: false,
      })
      setDraft('')
      onSent()
    } catch (submitError) {
      setError(friendlyErrorMessage(submitError, 'Send failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className={cn('agenthub-local-change-box', className)}
      onSubmit={(event) => {
        event.preventDefault()
        void submitLocalChange()
      }}
    >
      <div className="agenthub-local-change-header">
        <div className="agenthub-local-change-title">
          <TextQuote className="h-3.5 w-3.5" />
          Local change
        </div>
        <div className="agenthub-local-change-meta" title={target.filePath ?? target.sourceLabel}>
          <span>{target.filePath ?? target.sourceLabel}</span>
          <span>{target.lineLabel}</span>
        </div>
      </div>
      <textarea
        className="agenthub-local-change-textarea"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submitLocalChange()
          }
        }}
        placeholder="Describe the local change for the Agent..."
        rows={3}
        autoFocus
      />
      <div className="agenthub-local-change-footer">
        <span
          className={cn('agenthub-local-change-hint', error && 'agenthub-local-change-hint-error')}
        >
          {error || disabledReason || 'Ctrl / Cmd + Enter to send'}
        </span>
        <div className="agenthub-local-change-actions">
          <button
            type="button"
            className="agenthub-local-change-btn"
            onClick={onCancel}
            disabled={submitting}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
          <button
            type="submit"
            className="agenthub-local-change-btn agenthub-local-change-btn-send"
            disabled={!draft.trim() || submitting || Boolean(disabledReason)}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
            Send
          </button>
        </div>
      </div>
    </form>
  )
}

function buildLocalChangePrompt(target: LocalChangeTarget, instruction: string) {
  return [
    'Please make a local change based on the selected code fragment below.',
    target.filePath ? `File: ${target.filePath}` : 'File: current preview or message code block',
    `Range: ${target.lineLabel}`,
    `Source: ${target.sourceLabel}`,
    '',
    'Selected code:',
    codeFenceForContent(target.selectedText, target.language),
    '',
    'User instruction:',
    instruction,
  ].join('\n')
}

function buildLocalChangeDisplay(target: LocalChangeTarget, instruction: string) {
  const location = target.filePath ? `${target.filePath} ${target.lineLabel}` : target.lineLabel
  return `Local change: ${location}\n\n${instruction}`
}

function insertTextIntoComposer(value: string, inputType = 'insertText') {
  const input = document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
  if (!input) {
    void navigator.clipboard?.writeText(value).catch(() => undefined)
    return null
  }
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  input.focus()
  input.setSelectionRange(start, end)
  input.setRangeText(value, start, end, 'end')
  dispatchComposerInput(input, value, inputType)
  return input
}

function dispatchComposerInput(input: HTMLTextAreaElement, data: string, inputType = 'insertText') {
  try {
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }))
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  window.dispatchEvent(
    new CustomEvent(composerSyncEvent, {
      detail: { value: input.value, scrollTop: input.scrollTop },
    }),
  )
}

function formatLineRangeLabel(start?: number | string, end?: number | string) {
  const first = start ?? '?'
  const last = end ?? first
  if (`${first}` === `${last}`) return `line ${first}`
  return `lines ${first}-${last}`
}

function codeFenceForContent(content: string, language?: string) {
  const fence = content.includes('```') ? '````' : '```'
  const normalizedLanguage = (language ?? '').trim().split(/\s+/)[0]?.replace(/[^\w+-]/g, '') ?? ''
  return `${fence}${normalizedLanguage}\n${content}\n${fence}`
}

function previewKindLabel(item: ArtifactPreviewItem) {
  if (item.kind === 'web') return 'Web preview'
  if (item.kind === 'deploy') return 'Deployment'
  if (item.kind === 'diff') return 'Diff'
  if (item.kind === 'image') return 'Image'
  if (item.kind === 'workflow') return 'Workflow'
  if (isPdfPreviewItem(item) || isDocxPreviewItem(item) || isPptxPreviewItem(item)) return 'Document'
  return 'File'
}

function previewFileHint(item: ArtifactPreviewItem) {
  if (isPdfPreviewItem(item)) return 'PDF preview is available when the file can be read.'
  if (isDocxPreviewItem(item)) return 'Word document preview is available when the file can be read.'
  if (isPptxPreviewItem(item)) return 'PowerPoint preview is available when the file can be read.'
  if (item.mimeType) return item.mimeType
  return 'No inline renderer is available for this file type yet.'
}

type DiffRow = {
  kind: 'add' | 'context' | 'del' | 'hunk' | 'meta'
  marker: string
  newNumber?: number
  oldNumber?: number
  text: string
}

function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine: number | undefined
  let newLine: number | undefined
  let oldFilePath: string | undefined
  let newFilePath: string | undefined
  const rawLines = diff.split(/\r?\n/)

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index]
    if (index === rawLines.length - 1 && rawLine === '' && diff.endsWith('\n')) continue

    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/)
      oldLine = match ? Number(match[1]) : undefined
      newLine = match ? Number(match[2]) : undefined
      rows.push({ kind: 'hunk', marker: '@@', text: rawLine })
      continue
    }

    if (
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ') ||
      rawLine.startsWith('old mode ') ||
      rawLine.startsWith('new mode ') ||
      rawLine.startsWith('similarity index ') ||
      rawLine.startsWith('dissimilarity index ') ||
      rawLine.startsWith('rename from ') ||
      rawLine.startsWith('rename to ')
    ) {
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('--- ')) {
      oldFilePath = rawLine.slice(4).trim()
      oldLine = oldFilePath === '/dev/null' ? undefined : (oldLine ?? 1)
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('+++ ')) {
      newFilePath = rawLine.slice(4).trim()
      newLine = newFilePath === '/dev/null' ? undefined : (newLine ?? 1)
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('+')) {
      if (newLine === undefined && newFilePath && newFilePath !== '/dev/null') newLine = 1
      rows.push({ kind: 'add', marker: '+', newNumber: newLine, text: rawLine.slice(1) })
      if (newLine !== undefined) newLine += 1
      continue
    }

    if (rawLine.startsWith('-')) {
      if (oldLine === undefined && oldFilePath && oldFilePath !== '/dev/null') oldLine = 1
      rows.push({ kind: 'del', marker: '-', oldNumber: oldLine, text: rawLine.slice(1) })
      if (oldLine !== undefined) oldLine += 1
      continue
    }

    const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    if (oldLine === undefined && oldFilePath && oldFilePath !== '/dev/null') oldLine = 1
    if (newLine === undefined && newFilePath && newFilePath !== '/dev/null') newLine = 1
    rows.push({ kind: 'context', marker: '', oldNumber: oldLine, newNumber: newLine, text })
    if (oldLine !== undefined) oldLine += 1
    if (newLine !== undefined) newLine += 1
  }

  return rows
}

function buildEditableDiffFileContent(
  rows: DiffRow[],
  editedOriginalIndex: number,
  editedLineText: string,
) {
  const isNewFileDiff =
    rows.some((row) => row.kind === 'meta' && row.text === '--- /dev/null') &&
    rows.some(
      (row) =>
        row.kind === 'meta' &&
        row.text.startsWith('+++ ') &&
        row.text.trim() !== '+++ /dev/null',
    )
  if (!isNewFileDiff) return undefined

  return rows
    .flatMap((row, index) => {
      if (row.kind !== 'add' && row.kind !== 'context') return []
      return index === editedOriginalIndex ? [editedLineText] : [row.text]
    })
    .join('\n')
}

function guessLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    bash: 'bash',
    css: 'css',
    html: 'xml',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    sh: 'bash',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'xml',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash',
  }
  return map[ext] ?? ''
}

function highlightCode(code: string, language: string) {
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    }
    if (code.trim()) return hljs.highlightAuto(code, autoHighlightLanguages).value
  } catch {
    return escapeHtml(code)
  }
  return escapeHtml(code)
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function shouldSkipLineSelectionClick(event: ReactMouseEvent<HTMLElement>) {
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target?.closest('button, input, textarea, select, a')) return true
  return Boolean(window.getSelection()?.toString())
}
