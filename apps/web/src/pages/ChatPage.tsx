import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowUp, AtSign, ChevronRight, FolderOpen, FolderPlus, FolderX, Loader2, MoreHorizontal, PanelLeft, Paperclip, Plus, Search } from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { TypewriterHeading } from '../components/chat/TypewriterHeading'
import { readSlashCommand, SkillCommandPanel, Thread } from '../components/assistant-ui/Thread'
import { api, friendlyErrorMessage, type SkillSummary, type Workspace } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { isDesktopApp, pickWorkspaceFolder } from '../lib/native'
import { AgentHubRuntimeProvider } from '../lib/runtime'
import { requestSettingsDialog } from '../lib/settingsDialog'
import { sendModeShouldSubmit, useShortcutSettings } from '../lib/shortcuts'
import { isProjectWorkspace, workspaceSearchText, workspaceSubtitle } from '../lib/workspaceFilters'
import { useChatStore } from '../stores/chatStore'
import { requestNewSessionDialog } from '../components/chat/GlobalNewSessionDialog'

export default function ChatPage() {
  const { sessionId } = useParams()
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const initWebSocket = useChatStore((state) => state.initWebSocket)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const desktop = isDesktopApp()

  function toggleSidebar() {
    setSidebarCollapsed((current) => !current)
  }

  useEffect(() => {
    const off = initWebSocket()
    return off
  }, [initWebSocket])

  useEffect(() => {
    if (sessionId && sessionId !== currentSessionId) {
      selectSession(sessionId)
    }
  }, [sessionId, currentSessionId, selectSession])

  return (
    <div className="agenthub-chat-shell flex h-screen overflow-hidden bg-white text-neutral-950">
      <div
        aria-hidden={sidebarCollapsed}
        className="h-full shrink-0 overflow-hidden"
        style={{
          width: sidebarCollapsed ? 0 : 340,
          transition: 'width 300ms cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        <div
          className={[
            'h-full w-[340px] transform-gpu will-change-transform',
            sidebarCollapsed ? 'pointer-events-none -translate-x-full opacity-0' : 'translate-x-0 opacity-100',
          ].join(' ')}
          style={{
            transition: 'opacity 300ms cubic-bezier(0.4,0,0.2,1), transform 300ms cubic-bezier(0.4,0,0.2,1)',
          }}
        >
          <SessionList onCollapse={desktop ? undefined : toggleSidebar} />
        </div>
      </div>
      <main
        className="relative min-w-0 flex-1"
        style={{ ['--agenthub-thread-header-left-offset' as string]: desktop || sidebarCollapsed ? '3rem' : '0rem' }}
      >
        {(desktop || sidebarCollapsed) && (
          <button
            type="button"
            onClick={toggleSidebar}
            className="absolute left-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-500 shadow-sm transition hover:bg-neutral-50 hover:text-neutral-900"
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          >
            <PanelLeft className={['h-4 w-4 transition-transform', sidebarCollapsed ? 'rotate-180' : ''].join(' ')} />
          </button>
        )}
        {sessionId ? (
          <AgentHubRuntimeProvider>
            <Thread />
          </AgentHubRuntimeProvider>
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  )
}

function Welcome() {
  const { t } = useI18n()
  const { sendMode } = useShortcutSettings()
  const navigate = useNavigate()
  const messageInputRef = useRef<HTMLTextAreaElement>(null)
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const sendMessageToSession = useChatStore((state) => state.sendMessageToSession)
  const [message, setMessage] = useState('')
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillCommandRange, setSkillCommandRange] = useState<{ start: number; end: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [openingWorkspaceId, setOpeningWorkspaceId] = useState<string | null>(null)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [hint, setHint] = useState('')
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const filteredWorkspaces = workspaces.filter((workspace) => {
    const query = workspaceQuery.trim().toLowerCase()
    if (!query) return true
    return workspaceSearchText(workspace).includes(query)
  })

  useEffect(() => {
    if (!moreMenuOpen) return
    function handlePointerDown(event: PointerEvent) {
      if (moreMenuRef.current?.contains(event.target as Node)) return
      setMoreMenuOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMoreMenuOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreMenuOpen])

  useEffect(() => {
    if (!projectMenuOpen) return
    let cancelled = false
    setWorkspaceBusy(true)
    api
      .listWorkspaces()
      .then(({ items }) => {
        if (!cancelled) setWorkspaces(items.filter(isProjectWorkspace))
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
      .finally(() => {
        if (!cancelled) setWorkspaceBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectMenuOpen])

  useEffect(() => {
    if (!skillPanelOpen || skills.length) return
    let cancelled = false
    setSkillsLoading(true)
    api
      .listSkills()
      .then(({ items }) => {
        if (!cancelled) setSkills(items)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [skillPanelOpen, skills.length])

  function showHint(text: string) {
    setHint(text)
    window.setTimeout(() => setHint(''), 1800)
  }

  function closeSkillPanel() {
    setSkillPanelOpen(false)
    setSkillCommandRange(null)
    setSkillQuery('')
  }

  function handleMessageChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget
    const nextMessage = input.value
    const cursor = input.selectionStart ?? nextMessage.length
    const command = readSlashCommand(nextMessage, cursor)
    setMessage(nextMessage)
    if (command) {
      setProjectMenuOpen(false)
      setSkillQuery(command.query)
      setSkillCommandRange({ start: command.start, end: command.end })
      setSkillPanelOpen(true)
    } else {
      closeSkillPanel()
    }
  }

  function insertSkillReference(skill: SkillSummary) {
    const input = messageInputRef.current
    const reference = `$${skill.id || skill.name} `
    const cursor = input?.selectionStart ?? message.length
    const liveCommand = input ? readSlashCommand(input.value, cursor) : null
    const range = liveCommand ?? skillCommandRange ?? { start: message.length, end: message.length }
    const nextMessage = `${message.slice(0, range.start)}${reference}${message.slice(range.end)}`
    setMessage(nextMessage)
    closeSkillPanel()
    showHint(`已选择 Skill：${skill.name || skill.id}`)
    window.requestAnimationFrame(() => {
      const nextCursor = range.start + reference.length
      messageInputRef.current?.focus()
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  async function startThread(content: string) {
    const trimmed = content.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      const session = await createSession(titleFromMessage(trimmed), {
        workspaceId: selectedWorkspace?.id ?? null,
      })
      await selectSession(session.id)
      navigate(`/chat/${session.id}`)
      const result = await sendMessageToSession(session.id, trimmed)
      if (result?.groupSessionId) {
        navigate(`/chat/${result.groupSessionId}`)
      }
      setMessage('')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    await startThread(message)
  }

  async function selectWorkspace(workspaceId: string) {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    setOpeningWorkspaceId(workspaceId)
    showHint('正在选择工作区...')
    try {
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? (await api.getWorkspace(workspaceId)).workspace
      setSelectedWorkspace(workspace)
      setProjectMenuOpen(false)
      showHint(`已选择工作区：${workspace.name}`)
    } catch (err) {
      showHint(friendlyErrorMessage(err, '选择工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  async function createBlankWorkspace() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    try {
      const full = await api.createWorkspace({ name: '空白工作区', goal: '', projectPath: null, template: 'classic' })
      setWorkspaces((items) => [full.workspace, ...items.filter((item) => item.id !== full.workspace.id)])
      setOpeningWorkspaceId(full.workspace.id)
      setSelectedWorkspace(full.workspace)
      setProjectMenuOpen(false)
      showHint('已创建并选中工作区')
    } catch (err) {
      showHint(friendlyErrorMessage(err, '创建空白工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  async function openFolderWorkspace() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    showHint('正在打开工作区文件夹选择器...')
    try {
      const nativePath = await pickWorkspaceFolder().catch(() => null)
      const result = await api.openWorkspaceFolder(nativePath)
      if (result.cancelled || !result.projectPath) {
        showHint('已取消选择文件夹')
        return
      }
      showHint('已选择文件夹，正在处理工作区...')
      const workspace =
        result.workspace ??
        (
          await api.createWorkspace({
            name: workspaceNameFromPath(result.projectPath),
            goal: '',
            projectPath: result.projectPath,
            template: 'classic',
          })
        ).workspace
      setWorkspaces((items) => [workspace, ...items.filter((item) => item.id !== workspace.id)])
      setOpeningWorkspaceId(workspace.id)
      setSelectedWorkspace(workspace)
      setProjectMenuOpen(false)
      showHint('工作区已选中')
    } catch (err) {
      showHint(friendlyErrorMessage(err, '处理工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  function clearWorkspaceContext() {
    setSelectedWorkspace(null)
    setProjectMenuOpen(false)
    showHint('已清除工作区')
  }

  return (
    <div className="agenthub-welcome-root flex h-full flex-col bg-white">
      <div className="pointer-events-none absolute right-5 top-4 z-20">
        <div ref={moreMenuRef} className="pointer-events-auto relative">
          <button
            type="button"
            onClick={() => setMoreMenuOpen((open) => !open)}
            className="grid h-9 w-9 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
            aria-label="更多"
            title="更多"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {moreMenuOpen && (
            <div className="absolute right-0 top-11 z-30 w-44 rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl">
              <WelcomeMenuItem
                label="新建群聊"
                onClick={() => {
                  setMoreMenuOpen(false)
                  requestNewSessionDialog()
                }}
              />
              <WelcomeMenuItem
                label="Agent 配置"
                onClick={() => {
                  setMoreMenuOpen(false)
                  navigate('/agent-config')
                }}
              />
              <WelcomeMenuItem
                label="模型管理"
                onClick={() => {
                  setMoreMenuOpen(false)
                  navigate('/models')
                }}
              />
              <WelcomeMenuItem
                label="Coding Tools"
                onClick={() => {
                  setMoreMenuOpen(false)
                  navigate('/coding-tools')
                }}
              />
              <WelcomeMenuItem
                label="设置"
                onClick={() => {
                  setMoreMenuOpen(false)
                  requestSettingsDialog()
                }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center px-8">
        <section className="mt-[18vh] w-full max-w-[704px]">
          <h2 className="text-2xl font-semibold tracking-normal text-neutral-950">
            <TypewriterHeading text={t('有什么可以帮忙的？')} />
          </h2>
          <p className="mt-3 text-base text-neutral-500">
            {t('创建 Agent、拆解任务，或直接 @ 某个助手开始协作。')}
          </p>

          <div className="mt-24 grid gap-3 sm:grid-cols-2">
            <PromptCard
              title={t('开发小游戏')}
              text={t('帮我简单开发一个跳跃小游戏')}
              onClick={() => startThread('帮我简单开发一个跳跃小游戏')}
            />
            <PromptCard
              title={t('解释架构')}
              text={t('这个项目的具体技术栈')}
              onClick={() => startThread('解释这个项目的具体技术栈，并指出后续可完善的地方')}
            />
          </div>
        </section>

        <div className="agenthub-welcome-composer-dock mt-auto w-full max-w-[704px] pb-5">
          <form
            onSubmit={handleSubmit}
            className="relative rounded-[22px] border border-neutral-200 bg-white p-3 shadow-[0_18px_60px_rgba(15,23,42,0.12)]"
          >
            {hint && <div className="absolute -top-9 left-4 rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">{hint}</div>}
            {skillPanelOpen && (
              <SkillCommandPanel
                query={skillQuery}
                skills={skills}
                loading={skillsLoading}
                onPick={insertSkillReference}
                onClose={closeSkillPanel}
              />
            )}
            {projectMenuOpen && (
              <div className="absolute bottom-[4.5rem] left-3 z-20 w-80 rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm shadow-xl">
                <div className="flex h-9 items-center gap-2 px-2 text-neutral-400">
                  <Search className="h-4 w-4 shrink-0" />
                  <input
                    value={workspaceQuery}
                    onChange={(event) => setWorkspaceQuery(event.target.value)}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
                    placeholder={t('搜索工作区')}
                  />
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto py-1">
                  {filteredWorkspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => void selectWorkspace(workspace.id)}
                      disabled={workspaceBusy}
                      className={[
                        'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-50 disabled:opacity-60',
                        (workspace.id === selectedWorkspace?.id || workspace.id === openingWorkspaceId) ? 'bg-neutral-100' : '',
                      ].join(' ')}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-neutral-900">{workspace.name}</span>
                        <span className="block truncate text-[11px] text-neutral-400">{workspaceSubtitle(workspace)}</span>
                      </span>
                      {workspace.id === openingWorkspaceId && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />}
                    </button>
                  ))}
                  {!workspaceBusy && filteredWorkspaces.length === 0 && (
                    <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-5 text-center text-xs text-neutral-400">
                      {t('没有匹配的工作区')}
                    </div>
                  )}
                  {workspaceBusy && <div className="px-2.5 py-2 text-xs text-neutral-400">{t('正在处理工作区...')}</div>}
                </div>
                <div className="mt-1 border-t border-neutral-200 pt-1.5">
                  <div className="relative group/new-project">
                    <button
                      type="button"
                      onClick={() => setAddProjectOpen((open) => !open)}
                      className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-neutral-50"
                    >
                      <FolderPlus className="h-4 w-4 shrink-0 text-neutral-600" />
                      <span className="min-w-0 flex-1 truncate text-neutral-900">{t('添加工作区')}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                    </button>
                    <div
                      className={[
                        'absolute bottom-0 left-[calc(100%+0.35rem)] w-56 rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl transition group-hover/new-project:visible group-hover/new-project:opacity-100',
                        addProjectOpen ? 'visible opacity-100' : 'invisible opacity-0',
                      ].join(' ')}
                    >
                      <button
                        type="button"
                        onClick={() => void createBlankWorkspace()}
                        disabled={workspaceBusy}
                        className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-100 disabled:opacity-60"
                      >
                        <Plus className="h-4 w-4 shrink-0 text-neutral-600" />
                        {t('新建空白工作区')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openFolderWorkspace()}
                        disabled={workspaceBusy}
                        className="flex h-9 w-full items-center gap-2.5 rounded-lg bg-neutral-100 px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-200 disabled:opacity-60"
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                        {t('使用现有文件夹')}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={clearWorkspaceContext}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-50"
                  >
                    <FolderX className="h-4 w-4 shrink-0 text-neutral-600" />
                    {t('不使用工作区')}
                  </button>
                </div>
              </div>
            )}
            <textarea
              ref={messageInputRef}
              value={message}
              onChange={handleMessageChange}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && skillPanelOpen) {
                  event.preventDefault()
                  closeSkillPanel()
                  return
                }
                if (skillPanelOpen && event.key === 'Enter') {
                  event.preventDefault()
                  return
                }
                if (sendModeShouldSubmit(sendMode, event)) {
                  event.preventDefault()
                  void startThread(message)
                }
              }}
              className="h-14 w-full resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              placeholder={t('发消息给 AgentHub，@ 可提及 Agent')}
            />
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1">
                <button type="button" disabled title="暂未实现" className="grid h-8 w-8 place-items-center rounded-full text-neutral-300">
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setProjectMenuOpen((open) => !open)}
                  className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
                  aria-label={t('选择工作区')}
                  title={selectedWorkspace ? selectedWorkspace.name : t('选择工作区')}
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
                <button type="button" disabled title="暂未实现" className="grid h-8 w-8 place-items-center rounded-full text-neutral-300">
                  <Paperclip className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setMessage((current) => (current.includes('@') ? current : `${current}@`))}
                  className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
                >
                  <AtSign className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!message.trim() || submitting}
                  className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white disabled:bg-neutral-200"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function PromptCard({ title, text, onClick }: { title: string; text: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-[22px] border border-neutral-200 bg-white px-5 py-4 text-left shadow-sm transition hover:border-neutral-300"
    >
      <div className="text-sm font-medium text-neutral-950">{title}</div>
      <div className="mt-1 text-sm text-neutral-500">{text}</div>
    </button>
  )
}

function WelcomeMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center rounded-xl px-3 text-left text-sm text-neutral-900 transition hover:bg-neutral-100"
    >
      {label}
    </button>
  )
}

function titleFromMessage(message: string) {
  return message.length > 18 ? `${message.slice(0, 18)}...` : message
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '工作区文件夹'
}
