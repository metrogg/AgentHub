import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  PanelsRightBottom,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { ArtifactPreviewSurface } from '../artifacts/ArtifactPreviewSurface'
import {
  api,
  friendlyErrorMessage,
  type WorkspaceFileEntry,
  type WorkspaceFileTree,
} from '../../lib/api'
import {
  artifactPreviewEvent,
  enrichPreviewItem,
  extensionFromName,
  isPptxPreviewItem,
  mimeFromExtension,
  previewFileName,
  requestArtifactPreview,
  type ArtifactPreviewItem,
} from '../../lib/artifactPreview'
import { openInEditor, openPath } from '../../lib/native'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chatStore'

export type CodexWorkspaceSidecarTab = 'preview' | 'files' | 'tasks' | 'changes'

const codexSidecarWidthStorageKey = 'agenthub:codex-workspace-sidecar-width'
const codexSidecarMinWidth = 420
const codexSidecarNavigatorMinWidth = 560
const codexSidecarPresentationMinWidth = 1200
const codexSidecarDefaultMaxWidth = 780

type CodexWorkspaceSidecarProps = {
  activeTab: CodexWorkspaceSidecarTab
  onClose: () => void
  onSelectTab: (tab: CodexWorkspaceSidecarTab) => void
  open: boolean
}

export const CodexWorkspaceSidecar: FC<CodexWorkspaceSidecarProps> = ({
  activeTab,
  onClose,
  onSelectTab,
  open,
}) => {
  const workspace = useChatStore((state) => state.currentWorkspace)
  const taskBoard = useChatStore((state) => state.taskBoard)
  const workspaceId = workspace?.id ?? ''
  const [tree, setTree] = useState<WorkspaceFileTree | null>(null)
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileEntry | null>(null)
  const [recentFiles, setRecentFiles] = useState<WorkspaceFileEntry[]>([])
  const [previewItem, setPreviewItem] = useState<ArtifactPreviewItem | null>(null)
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const [sidecarWidth, setSidecarWidth] = useState(() => readStoredCodexSidecarWidth())
  const [resizingSidecar, setResizingSidecar] = useState(false)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const sidecarWidthRef = useRef(sidecarWidth)

  useEffect(() => {
    function handlePreview(event: Event) {
      const raw = (event as CustomEvent<ArtifactPreviewItem>).detail
      if (!raw?.id) return
      const state = useChatStore.getState()
      const item = enrichPreviewItem(raw, raw.workspaceId ?? state.currentSession?.workspaceId ?? undefined)
      setPreviewItem(item)
      if (item.path) {
        setSelectedFile({
          extension: extensionFromName(item.path) ?? null,
          modifiedAt: new Date().toISOString(),
          name: previewFileName(item),
          path: item.path,
          size: null,
          type: 'file',
        })
      }
      onSelectTab('preview')
    }

    window.addEventListener(artifactPreviewEvent, handlePreview)
    return () => window.removeEventListener(artifactPreviewEvent, handlePreview)
  }, [onSelectTab])

  useEffect(() => {
    setPath('')
    setQuery('')
    setTree(null)
    setSelectedFile(null)
    setRecentFiles([])
    setPreviewItem(null)
    setError('')
    setNotice('')
  }, [workspaceId])

  useEffect(() => {
    if (!open || !workspaceId) return
    let cancelled = false
    setLoading(true)
    setError('')
    api
      .listWorkspaceFiles(workspaceId, path)
      .then((nextTree) => {
        if (cancelled) return
        setTree(nextTree)
      })
      .catch((err) => {
        if (cancelled) return
        setError(friendlyErrorMessage(err, '读取工作区文件失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, path, refreshToken, workspaceId])

  useEffect(() => {
    sidecarWidthRef.current = sidecarWidth
  }, [sidecarWidth])

  useEffect(() => {
    if (!resizingSidecar || typeof document === 'undefined') return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [resizingSidecar])

  useEffect(() => {
    if (typeof window === 'undefined') return
    function handleWindowResize() {
      setSidecarWidth((value) => {
        const nextWidth = clampCodexSidecarWidth(value)
        sidecarWidthRef.current = nextWidth
        return nextWidth
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  const items = useMemo(() => sortWorkspaceItems(tree?.items ?? []), [tree?.items])
  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) => item.name.toLowerCase().includes(keyword) || item.path.toLowerCase().includes(keyword))
  }, [items, query])
  const breadcrumbs = path.split('/').filter(Boolean)
  const parentPath = breadcrumbs.slice(0, -1).join('/')
  const selectedFilePath = selectedFile
    ? resolveWorkspacePath(selectedFile.path, workspace?.projectPath ?? tree?.projectPath)
    : null
  const addressValue = activeTab === 'preview' && previewItem?.url ? previewItem.url : `/${path}`
  const previewTitle = previewItem ? previewFileName(previewItem) : selectedFile?.name ?? 'README.md'
  const activeTabLabel =
    activeTab === 'preview'
      ? previewTitle
      : activeTab === 'changes'
        ? 'Changes'
        : activeTab === 'tasks'
          ? 'Tasks'
          : workspace?.name ?? tree?.rootName ?? 'AgentHub'
  const openTabs = [
    workspace?.name ?? tree?.rootName ?? 'Workspace',
    ...(previewItem ? [previewFileName(previewItem)] : []),
    ...(selectedFile && previewFileName(previewItem ?? { id: '', title: selectedFile.name, kind: 'file', path: selectedFile.path }) !== selectedFile.name
      ? [selectedFile.name]
      : []),
  ].slice(0, 4)
  const shouldShowFileNavigator = activeTab === 'files' || (activeTab === 'preview' && Boolean(selectedFile))
  const shouldExpandPresentationPreview = activeTab === 'preview' && Boolean(previewItem && isPptxPreviewItem(previewItem))
  const requiredSidecarWidth = shouldExpandPresentationPreview
    ? Math.min(codexSidecarPresentationMinWidth, getCodexSidecarMaxWidth())
    : shouldShowFileNavigator
      ? Math.min(codexSidecarNavigatorMinWidth, getCodexSidecarMaxWidth())
      : codexSidecarMinWidth
  const visibleSidecarWidth = Math.max(sidecarWidth, requiredSidecarWidth)
  const quickFiles =
    recentFiles.length > 0
      ? recentFiles
      : items
          .filter((item) => item.type === 'file')
          .slice()
          .sort((a, b) => Date.parse(b.modifiedAt || '') - Date.parse(a.modifiedAt || ''))
          .slice(0, 5)

  if (!open) return null

  function openDirectory(nextPath: string) {
    setPath(nextPath)
    setQuery('')
  }

  function openAddress(value: string) {
    const previewUrl = normalizeWorkspaceSidecarPreviewUrl(value)
    if (previewUrl) {
      const item = webPreviewItemFromUrl(previewUrl)
      setPreviewItem(item)
      setSelectedFile(null)
      onSelectTab('preview')
      requestArtifactPreview(item)
      return
    }
    openDirectory(normalizeWorkspaceSidecarAddress(value))
  }

  function focusAddressBar() {
    setNewTabMenuOpen(false)
    window.setTimeout(() => {
      addressInputRef.current?.focus()
      addressInputRef.current?.select()
    }, 0)
  }

  function previewWorkspaceFile(file: WorkspaceFileEntry) {
    if (!workspaceId || file.type !== 'file') return
    setSelectedFile(file)
    setRecentFiles((files) => [file, ...files.filter((item) => item.path !== file.path)].slice(0, 8))
    const item = workspaceFilePreviewItem(file, workspaceId)
    setPreviewItem(item)
    onSelectTab('preview')
    requestArtifactPreview(item)
  }

  async function openWorkspaceFolder() {
    const projectPath = workspace?.projectPath ?? tree?.projectPath
    if (!projectPath) {
      setNotice('当前工作区没有可打开的本地路径。')
      return
    }
    try {
      const opened = await openPath(projectPath)
      setNotice(opened ? '已请求系统打开工作区。' : '当前环境不支持直接打开工作区。')
    } catch (err) {
      setNotice(friendlyErrorMessage(err, '打开工作区失败'))
    }
  }

  async function openSelectedInEditor() {
    if (!selectedFilePath) {
      setNotice('先在文件树中选择一个文件。')
      return
    }
    try {
      const opened = await openInEditor(selectedFilePath)
      if (opened) {
        setNotice('已请求编辑器打开当前文件。')
        return
      }
      const openedPath = await openPath(selectedFilePath)
      setNotice(openedPath ? '已请求系统打开当前文件。' : '当前环境不支持直接打开文件。')
    } catch (err) {
      setNotice(friendlyErrorMessage(err, '打开文件失败'))
    }
  }

  async function copyPath() {
    const value = selectedFilePath ?? workspace?.projectPath ?? tree?.projectPath
    if (!value) {
      setNotice('当前没有可复制的路径。')
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      setNotice('路径已复制。')
    } catch (err) {
      setNotice(friendlyErrorMessage(err, '复制路径失败'))
    }
  }

  function applySidecarWidth(value: number, persist = false) {
    const nextWidth = clampCodexSidecarWidth(value)
    sidecarWidthRef.current = nextWidth
    setSidecarWidth(nextWidth)
    if (persist) persistCodexSidecarWidth(nextWidth)
  }

  function updateSidecarWidthFromPointer(clientX: number) {
    if (typeof window === 'undefined') return
    applySidecarWidth(window.innerWidth - clientX)
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    setResizingSidecar(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    updateSidecarWidthFromPointer(event.clientX)
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizingSidecar || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    updateSidecarWidthFromPointer(event.clientX)
  }

  function finishSidecarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizingSidecar(false)
    persistCodexSidecarWidth(sidecarWidthRef.current)
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      applySidecarWidth(sidecarWidthRef.current + 32, true)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      applySidecarWidth(sidecarWidthRef.current - 32, true)
    } else if (event.key === 'Home') {
      event.preventDefault()
      applySidecarWidth(requiredSidecarWidth, true)
    } else if (event.key === 'End') {
      event.preventDefault()
      applySidecarWidth(getCodexSidecarMaxWidth(), true)
    }
  }

  return (
    <aside
      className="agenthub-codex-sidecar relative flex h-full min-w-[420px] shrink-0 flex-col bg-white text-neutral-950"
      style={{ width: visibleSidecarWidth }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemax={getCodexSidecarMaxWidth()}
        aria-valuemin={requiredSidecarWidth}
        aria-valuenow={visibleSidecarWidth}
        onKeyDown={handleResizeKeyDown}
        onPointerCancel={finishSidecarResize}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={finishSidecarResize}
        className={cn(
          'group absolute -left-1 top-0 z-50 h-full w-2 cursor-col-resize touch-none outline-none',
          resizingSidecar && 'bg-blue-500/5',
        )}
        title="拖动调整侧边栏宽度"
      >
        <span
          className={cn(
            'absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-transparent transition group-hover:bg-blue-500 group-focus-visible:bg-blue-500',
            resizingSidecar && 'bg-blue-500',
          )}
        />
      </div>
      <div className="order-2 flex h-11 shrink-0 items-center gap-2 bg-white px-2.5">
        <CodexChromeButton label="后退" disabled={!path} onClick={() => openDirectory(parentPath)}>
          <ChevronLeft className="h-4 w-4" />
        </CodexChromeButton>
        <CodexChromeButton label="前进" disabled onClick={() => undefined}>
          <ChevronRight className="h-4 w-4" />
        </CodexChromeButton>
        <div className="mx-auto flex h-8 min-w-[180px] max-w-[560px] flex-[1_1_560px] items-center gap-1 overflow-hidden rounded-xl bg-white px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              openAddress(String(data.get('address') ?? ''))
            }}
          >
            <input
              ref={addressInputRef}
              name="address"
              defaultValue={addressValue}
              key={addressValue}
              className="h-7 w-full bg-transparent text-sm text-neutral-700 outline-none"
              spellCheck={false}
              aria-label="工作区地址"
            />
          </form>
        </div>
        <CodexChromeButton label="刷新" onClick={() => setRefreshToken((value) => value + 1)}>
          <RefreshCw className="h-4 w-4" />
        </CodexChromeButton>
      </div>

      <div className="relative order-1 flex h-11 shrink-0 items-center bg-white px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <button
            type="button"
            onClick={() => onSelectTab('files')}
            className={cn(
              'agenthub-codex-sidecar-tab inline-flex h-8 max-w-[12rem] shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm transition',
              activeTab === 'files'
                ? 'text-neutral-950'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
            )}
            title={workspace?.projectPath ?? tree?.projectPath ?? workspace?.name ?? '工作区'}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate">{openTabs[0]}</span>
          </button>
          {openTabs.slice(1).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => onSelectTab('preview')}
              className={cn(
                'agenthub-codex-sidecar-tab inline-flex h-8 max-w-[10rem] shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm transition',
                activeTab === 'preview'
                  ? 'text-neutral-950'
                  : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
              )}
              title={tab}
            >
              {fileIconFromName(tab)}
              <span className="truncate">{tab}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelectTab('changes')}
            className={cn(
              'agenthub-codex-sidecar-tab inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm transition',
              activeTab === 'changes'
                ? 'text-neutral-950'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
            )}
          >
            <GitBranch className="h-4 w-4" />
            Changes
          </button>
          <button
            type="button"
            onClick={() => onSelectTab('tasks')}
            className={cn(
              'agenthub-codex-sidecar-tab inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm transition',
              activeTab === 'tasks'
                ? 'text-neutral-950'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
            )}
          >
            <PanelsRightBottom className="h-4 w-4" />
            Tasks
          </button>
          <button
            type="button"
            onClick={() => setNewTabMenuOpen((value) => !value)}
            className={cn(
              'agenthub-codex-sidecar-button grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950',
              newTabMenuOpen && 'text-neutral-950',
            )}
            aria-expanded={newTabMenuOpen}
            aria-haspopup="menu"
            aria-label="新建侧栏标签"
            title="新建侧栏标签"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {newTabMenuOpen && (
          <CodexSidecarNewTabMenu
            onFocusAddress={focusAddressBar}
            onOpenChanges={() => {
              setNewTabMenuOpen(false)
              onSelectTab('changes')
            }}
            onOpenFiles={() => {
              setNewTabMenuOpen(false)
              onSelectTab('files')
            }}
            onOpenTasks={() => {
              setNewTabMenuOpen(false)
              onSelectTab('tasks')
            }}
          />
        )}
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <CodexChromeButton label="弹出预览" onClick={() => setNotice('外部预览入口稍后接入。')}>
            <Maximize2 className="h-4 w-4" />
          </CodexChromeButton>
          <CodexChromeButton label="最小化" onClick={onClose}>
            <Minimize2 className="h-4 w-4" />
          </CodexChromeButton>
          <CodexChromeButton label="收起侧边栏" onClick={onClose}>
            <PanelRightClose className="h-4 w-4" />
          </CodexChromeButton>
        </div>
      </div>

      <div className="order-3 flex min-h-0 flex-1 flex-row-reverse">
        {shouldShowFileNavigator && (
          <aside className="flex w-[240px] shrink-0 flex-col bg-white">
            <div className="flex h-10 shrink-0 items-center gap-2 px-3">
              <button
                type="button"
                onClick={() => void openWorkspaceFolder()}
                className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-white px-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
                title="用系统打开工作区"
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-blue-600" />
                打开
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              </button>
              <button
                type="button"
                onClick={() => void openSelectedInEditor()}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-950"
                aria-label="在编辑器打开"
                title="在编辑器打开"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void copyPath()}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-950"
                aria-label="复制路径"
                title="复制路径"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <div className="shrink-0 p-3">
              <div className="flex h-8 items-center gap-2 rounded-xl bg-white px-2.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-full min-w-0 flex-1 bg-transparent text-sm text-neutral-700 outline-none"
                  placeholder="筛选文件..."
                  aria-label="筛选文件"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="grid h-5 w-5 place-items-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                    aria-label="清空筛选"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!workspaceId ? (
                <CodexEmptyState
                  compact
                  icon={<FolderOpen className="h-5 w-5" />}
                  title="未选择工作区"
                  text="选择工作区后这里会显示文件树。"
                />
              ) : loading ? (
                <CodexEmptyState compact icon={<RefreshCw className="h-5 w-5 animate-spin" />} title="加载中" text="正在读取文件树。" />
              ) : error ? (
                <CodexEmptyState compact icon={<FileText className="h-5 w-5" />} title="读取失败" text={error} />
              ) : (
                <div className="space-y-0.5">
                  {path && (
                    <WorkspaceFileRow
                      icon={<FolderOpen className="h-4 w-4" />}
                      label=".."
                      muted
                      onClick={() => openDirectory(parentPath)}
                    />
                  )}
                  {filteredItems.map((item) => (
                    <WorkspaceFileRow
                      key={item.path}
                      active={selectedFile?.path === item.path}
                      icon={workspaceFileIcon(item)}
                      label={item.name}
                      meta={item.type === 'file' && item.size !== null ? formatBytes(item.size) : undefined}
                      onClick={() => (item.type === 'directory' ? openDirectory(item.path) : previewWorkspaceFile(item))}
                      title={item.path}
                    />
                  ))}
                  {!filteredItems.length && (
                    <CodexEmptyState compact icon={<Search className="h-5 w-5" />} title="没有匹配文件" text="换一个筛选词试试。" />
                  )}
                </div>
              )}
            </div>
            {tree?.truncated && (
              <div className="shrink-0 px-3 py-2 text-xs text-amber-700">
                文件较多，已截断显示。
              </div>
            )}
          </aside>
        )}

        <section className="min-w-0 flex-1 overflow-hidden bg-white">
          <div className="flex h-10 shrink-0 items-center gap-2 px-4 text-sm text-neutral-500">
            <span className="truncate">{workspace?.name ?? tree?.rootName ?? 'AgentHub'}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-medium text-neutral-900">{activeTabLabel}</span>
            <div className="min-w-0 flex-1" />
            {notice && (
              <span className="max-w-[16rem] truncate text-xs text-neutral-400" title={notice}>
                {notice}
              </span>
            )}
          </div>
          <div className="agenthub-codex-sidecar-pane h-[calc(100%-2.5rem)] min-h-0 overflow-hidden">
            {activeTab === 'preview' ? (
              previewItem ? (
                <ArtifactPreviewSurface
                  className="h-full"
                  item={previewItem}
                  workspaceId={previewItem.workspaceId ?? workspaceId}
                />
              ) : (
                <CodexEmptyState
                  icon={<FileText className="h-5 w-5" />}
                  title="暂无预览"
                  text="从右侧文件树或消息里的产物卡打开一个文件。"
                />
              )
            ) : activeTab === 'changes' ? (
              <CodexChangesPane taskCount={taskBoard?.tasks.length ?? 0} />
            ) : activeTab === 'tasks' ? (
              <CodexTasksPane taskBoard={taskBoard} />
            ) : (
              <CodexWorkspaceLanding
                projectPath={workspace?.projectPath ?? tree?.projectPath}
                quickFiles={quickFiles}
                workspaceName={workspace?.name ?? tree?.rootName ?? '工作区'}
                onOpenFile={previewWorkspaceFile}
              />
            )}
          </div>
        </section>
      </div>
    </aside>
  )
}

const CodexChromeButton: FC<{
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}> = ({ children, disabled = false, label, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="agenthub-codex-sidecar-button grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-neutral-500"
    aria-label={label}
    title={label}
  >
    {children}
  </button>
)

const CodexSidecarNewTabMenu: FC<{
  onFocusAddress: () => void
  onOpenChanges: () => void
  onOpenFiles: () => void
  onOpenTasks: () => void
}> = ({ onFocusAddress, onOpenChanges, onOpenFiles, onOpenTasks }) => (
  <div
    role="menu"
    className="agenthub-codex-sidecar-menu absolute right-24 top-10 z-50 w-64 overflow-hidden rounded-xl bg-white py-1.5 text-sm text-neutral-800"
  >
    <CodexSidecarMenuItem
      icon={<FolderOpen className="h-4 w-4" />}
      label="打开文件树"
      shortcut="Files"
      onClick={onOpenFiles}
    />
    <CodexSidecarMenuItem
      icon={<Search className="h-4 w-4" />}
      label="输入网址或路径"
      shortcut="URL"
      onClick={onFocusAddress}
    />
    <div className="my-1" />
    <CodexSidecarMenuItem
      icon={<GitBranch className="h-4 w-4" />}
      label="打开 Changes"
      shortcut="Diff"
      onClick={onOpenChanges}
    />
    <CodexSidecarMenuItem
      icon={<PanelsRightBottom className="h-4 w-4" />}
      label="打开 Tasks"
      shortcut="Run"
      onClick={onOpenTasks}
    />
  </div>
)

const CodexSidecarMenuItem: FC<{
  icon: ReactNode
  label: string
  onClick: () => void
  shortcut: string
}> = ({ icon, label, onClick, shortcut }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className="agenthub-codex-sidecar-menu-item flex h-9 w-full items-center gap-2 px-3 text-left transition hover:bg-neutral-100"
  >
    <span className="grid h-5 w-5 shrink-0 place-items-center text-neutral-500">{icon}</span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
    <span className="shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
      {shortcut}
    </span>
  </button>
)

const WorkspaceFileRow: FC<{
  active?: boolean
  icon: ReactNode
  label: string
  meta?: string
  muted?: boolean
  onClick: () => void
  title?: string
}> = ({ active = false, icon, label, meta, muted = false, onClick, title }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'agenthub-codex-sidecar-row group flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition hover:bg-neutral-100',
      active && 'text-neutral-950',
      muted ? 'text-neutral-400' : 'text-neutral-800',
    )}
    title={title ?? label}
  >
    <span className="grid h-5 w-5 shrink-0 place-items-center text-neutral-400 transition group-hover:text-neutral-700">
      {icon}
    </span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {meta && <span className="shrink-0 text-[10px] text-neutral-400">{meta}</span>}
  </button>
)

const CodexEmptyState: FC<{
  compact?: boolean
  icon: ReactNode
  text: string
  title: string
}> = ({ compact = false, icon, text, title }) => (
  <div
    className={cn(
      'flex h-full min-h-0 flex-col items-center justify-center px-6 text-center',
      compact ? 'py-8' : 'py-16',
    )}
  >
    <div className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-neutral-400">
      {icon}
    </div>
    <div className="mt-3 text-sm font-semibold text-neutral-950">{title}</div>
    <div className="mt-1 max-w-[18rem] text-xs leading-5 text-neutral-500">{text}</div>
  </div>
)

const CodexWorkspaceLanding: FC<{
  onOpenFile: (file: WorkspaceFileEntry) => void
  projectPath?: string | null
  quickFiles: WorkspaceFileEntry[]
  workspaceName: string
}> = ({ onOpenFile, projectPath, quickFiles, workspaceName }) => (
  <div className="h-full overflow-y-auto bg-white p-5">
    <div className="rounded-2xl bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-blue-600">
          <FolderOpen className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-neutral-950">{workspaceName}</div>
          <div className="mt-1 truncate text-xs text-neutral-500" title={projectPath ?? undefined}>
            {projectPath ?? '没有绑定本地目录'}
          </div>
        </div>
      </div>
    </div>
    <div className="mt-4 rounded-2xl bg-white p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          最近文件
        </span>
        <span className="text-xs text-neutral-400">{quickFiles.length}</span>
      </div>
      {quickFiles.length ? (
        <div className="space-y-1">
          {quickFiles.map((file) => (
            <WorkspaceFileRow
              key={`quick-${file.path}`}
              icon={workspaceFileIcon(file)}
              label={file.name}
              meta={file.size !== null ? formatBytes(file.size) : undefined}
              onClick={() => onOpenFile(file)}
              title={file.path}
            />
          ))}
        </div>
      ) : (
        <div className="px-1 py-6 text-center text-xs text-neutral-400">暂无可快速打开的文件。</div>
      )}
    </div>
  </div>
)

const CodexChangesPane: FC<{ taskCount: number }> = ({ taskCount }) => (
  <CodexEmptyState
    icon={<GitBranch className="h-5 w-5" />}
    title="变更视图"
    text={taskCount ? '这里会承载运行产物、代码 diff 和审查入口。' : '运行产生 diff 后，这里会按文件展示变更。'}
  />
)

const CodexTasksPane: FC<{ taskBoard: ReturnType<typeof useChatStore.getState>['taskBoard'] }> = ({
  taskBoard,
}) => {
  const tasks = taskBoard?.tasks ?? []
  if (!tasks.length) {
    return (
      <CodexEmptyState
        icon={<PanelsRightBottom className="h-5 w-5" />}
        title="暂无任务"
        text="Manager 派发任务后，这里会显示任务卡片和执行状态。"
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-white p-4">
      <div className="space-y-2">
        {tasks.map((task) => (
          <div key={task.id} className="rounded-2xl bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-950">
                {task.title}
              </div>
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] text-neutral-500">
                {task.status}
              </span>
            </div>
            {task.description && (
              <div className="mt-2 line-clamp-2 text-xs leading-5 text-neutral-500">{task.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function workspaceFilePreviewItem(file: WorkspaceFileEntry, workspaceId: string): ArtifactPreviewItem {
  const extension = extensionFromName(file.path)
  const mimeType = mimeFromExtension(extension)
  const isHtml = extension === 'html' || extension === 'htm'
  const isImage = mimeType?.startsWith('image/')
  return {
    id: `workspace-file-${workspaceId}-${file.path}`,
    kind: isHtml ? 'web' : isImage ? 'image' : 'file',
    mimeType,
    path: file.path,
    subtitle: [mimeType, file.size !== null ? formatBytes(file.size) : null].filter(Boolean).join(' | '),
    title: file.name,
    workspaceId,
  }
}

function sortWorkspaceItems(items: WorkspaceFileEntry[]) {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

function workspaceFileIcon(file: WorkspaceFileEntry) {
  if (file.type === 'directory') return <Folder className="h-4 w-4" />
  return fileIconFromName(file.name)
}

function fileIconFromName(name: string) {
  const extension = extensionFromName(name)
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'md', 'py', 'sh'].includes(extension ?? '')) {
    return <FileCode2 className="h-4 w-4" />
  }
  if (['doc', 'docx', 'pdf', 'txt'].includes(extension ?? '')) {
    return <FileText className="h-4 w-4" />
  }
  return <File className="h-4 w-4" />
}

function normalizeWorkspaceSidecarAddress(value: string) {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/)?/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

function normalizeWorkspaceSidecarPreviewUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('.') || trimmed.includes('\\')) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1|\[[\d:a-f]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : null
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}

function webPreviewItemFromUrl(url: string): ArtifactPreviewItem {
  const parsed = new URL(url)
  const title = parsed.hostname + (parsed.port ? `:${parsed.port}` : '')
  return {
    id: `web-preview-${url}`,
    kind: 'web',
    subtitle: parsed.href,
    title,
    url,
  }
}

function readStoredCodexSidecarWidth() {
  if (typeof window === 'undefined') return codexSidecarDefaultMaxWidth
  const stored = Number(window.localStorage.getItem(codexSidecarWidthStorageKey))
  return clampCodexSidecarWidth(Number.isFinite(stored) ? stored : codexSidecarDefaultMaxWidth)
}

function persistCodexSidecarWidth(width: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(codexSidecarWidthStorageKey, String(clampCodexSidecarWidth(width)))
}

function clampCodexSidecarWidth(width: number) {
  const maxWidth = getCodexSidecarMaxWidth()
  return Math.min(Math.max(Math.round(width), codexSidecarMinWidth), maxWidth)
}

function getCodexSidecarMaxWidth() {
  if (typeof window === 'undefined') return codexSidecarDefaultMaxWidth
  return Math.max(codexSidecarMinWidth, window.innerWidth)
}

function resolveWorkspacePath(path: string, workspacePath?: string | null) {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    return path
  }
  if (!workspacePath) return path
  return `${workspacePath.replace(/[\\/]+$/, '')}\\${path.replace(/^[\\/]+/, '')}`
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}
