import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  MessageCircle,
  RefreshCw,
  Settings2,
  Sparkles,
  Users,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { api, friendlyErrorMessage, type Session, type StarOfficeStatus } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { buildSessionTree } from '../lib/sessionTree'
import { cn, relativeTime } from '../lib/utils'
import { useChatStore } from '../stores/chatStore'

const DEFAULT_STAR_OFFICE_URL = 'http://127.0.0.1:19000'

type OfficePanel = 'session' | 'settings'

export default function OfficePage() {
  const { language } = useI18n()
  const sessions = useChatStore((state) => state.sessions)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const loadingSessions = useChatStore((state) => state.loadingSessions)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [frameKey, setFrameKey] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [officeBusy, setOfficeBusy] = useState(false)
  const [officeError, setOfficeError] = useState<string | null>(null)
  const [officeStatus, setOfficeStatus] = useState<StarOfficeStatus | null>(null)
  const [activePanel, setActivePanel] = useState<OfficePanel>('session')
  const [boundSessionId, setBoundSessionId] = useState<string | null>(null)

  const availableSessions = useMemo(() => {
    const seen = new Set<string>()
    return buildSessionTree(sessions).map((group) => group.parent).filter((session) => {
      const key = sessionDedupKey(session)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [sessions])

  const boundSession =
    availableSessions.find((session) => session.id === boundSessionId) ??
    availableSessions.find((session) => session.id === currentSessionId) ??
    null
  const officeUrl = officeStatus?.url ?? DEFAULT_STAR_OFFICE_URL
  const canRenderOffice = Boolean(officeStatus?.running)

  useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    void ensureOffice()
  }, [])

  useEffect(() => {
    if (boundSessionId && availableSessions.some((session) => session.id === boundSessionId)) return
    if (currentSessionId && availableSessions.some((session) => session.id === currentSessionId)) {
      setBoundSessionId(currentSessionId)
      return
    }
    setBoundSessionId(availableSessions[0]?.id ?? null)
  }, [availableSessions, boundSessionId, currentSessionId])

  async function ensureOffice() {
    setOfficeBusy(true)
    setOfficeError(null)
    setLoaded(false)
    try {
      const status = await api.startStarOffice()
      setOfficeStatus(status)
      if (!status.running) {
        setOfficeError(status.error ?? 'Star Office 暂未启动')
      }
    } catch (error) {
      setOfficeStatus(null)
      setOfficeError(friendlyErrorMessage(error, '启动 Star Office 失败'))
    } finally {
      setOfficeBusy(false)
    }
  }

  function reloadOffice() {
    setFrameKey((current) => current + 1)
    void ensureOffice()
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f5f4ef] text-neutral-950">
      <SessionList />

      <main className="flex min-w-0 flex-1 overflow-hidden">
        <aside className="flex h-full w-80 shrink-0 flex-col border-r border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-950 text-white">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold tracking-normal">Star Office</h1>
                <p className="truncate text-sm text-neutral-500">AgentHub 办公室看板</p>
              </div>
            </div>
          </div>

          <nav className="space-y-2 border-b border-neutral-200 p-3">
            <OfficeMenuButton
              active={activePanel === 'session'}
              icon={<MessageCircle className="h-4 w-4" />}
              label="切换会话"
              onClick={() => setActivePanel('session')}
            />
            <OfficeMenuButton
              active={activePanel === 'settings'}
              icon={<Settings2 className="h-4 w-4" />}
              label="办公室设置"
              onClick={() => setActivePanel('settings')}
            />
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {activePanel === 'session' ? (
              <section>
                <div className="rounded-lg border border-neutral-200 bg-[#fafaf7] p-3">
                  <div className="text-xs font-medium text-neutral-400">当前绑定</div>
                  <div className="mt-2 truncate text-sm font-semibold text-neutral-950">
                    {boundSession?.title ?? '未绑定会话'}
                  </div>
                  <div className="mt-1 truncate text-xs text-neutral-500">
                    {boundSession
                      ? `${sessionTypeText(boundSession)} · ${relativeTime(boundSession.updatedAt, language)}`
                      : '只从当前已有会话中选择'}
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-neutral-900">现有会话</div>
                  </div>
                  {loadingSessions ? (
                    <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
                  ) : (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
                      {availableSessions.length}
                    </span>
                  )}
                </div>

                <div className="mt-3 space-y-2">
                  {availableSessions.map((session) => (
                    <SessionBindButton
                      key={session.id}
                      session={session}
                      active={session.id === boundSession?.id}
                      language={language}
                      onClick={() => setBoundSessionId(session.id)}
                    />
                  ))}
                  {!loadingSessions && availableSessions.length === 0 && (
                    <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-sm text-neutral-500">
                      还没有可绑定的会话。
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section>
                <div className="text-sm font-semibold text-neutral-900">办公室设置</div>
                <p className="mt-1 text-xs leading-5 text-neutral-500">
                  页面打开时会自动拉起本地 Star Office 后端；刷新会重新探活并重载嵌入窗口。
                </p>

                <div className="mt-4 grid gap-2">
                  <button
                    type="button"
                    onClick={reloadOffice}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:border-neutral-300 hover:bg-neutral-50"
                  >
                    {officeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    重新连接
                  </button>
                  <a
                    href={officeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-neutral-950 text-sm font-semibold text-white transition hover:bg-neutral-800"
                  >
                    <ExternalLink className="h-4 w-4" />
                    新窗口打开
                  </a>
                </div>

                <div className="mt-5 rounded-lg border border-neutral-200 bg-[#fafaf7] p-3">
                  <div className="text-sm font-semibold text-neutral-900">连接状态</div>
                  <div className="mt-3 space-y-2 text-xs text-neutral-500">
                    <div className="flex items-center justify-between gap-3">
                      <span>服务</span>
                      <span className={officeStatus?.running ? 'text-emerald-700' : 'text-red-600'}>
                        {officeStatus?.running ? '运行中' : officeBusy ? '启动中' : '未连接'}
                      </span>
                    </div>
                    <div className="break-all rounded-md bg-white px-2 py-2 text-neutral-600">{officeUrl}</div>
                    {officeError && <div className="text-red-600">{officeError}</div>}
                  </div>
                </div>
              </section>
            )}
          </div>
        </aside>

        <section className="agenthub-embedded-window flex min-w-0 flex-1 flex-col bg-[#f5f4ef] p-4">
          <header className="mb-3 flex h-12 shrink-0 items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf7f3] text-emerald-700">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-neutral-950">AgentHub Office</div>
                <div className="truncate text-sm text-neutral-500">
                  {boundSession ? `已绑定会话：${boundSession.title}` : '未绑定会话'}
                </div>
              </div>
            </div>
            <ConnectionBadge running={Boolean(officeStatus?.running)} busy={officeBusy} loaded={loaded} />
          </header>

          <div className="agenthub-embedded-frame relative min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
            {canRenderOffice && (
              <iframe
                key={frameKey}
                title="Star Office UI"
                src={officeUrl}
                onLoad={() => setLoaded(true)}
                className="agenthub-embedded-iframe h-full w-full border-0 bg-white"
                allow="clipboard-read; clipboard-write"
              />
            )}

            {(!canRenderOffice || !loaded) && (
              <div className="agenthub-embedded-loading absolute inset-0 z-10 grid place-items-center bg-white/90 backdrop-blur-sm">
                <div className="w-[24rem] rounded-lg border border-neutral-200 bg-white p-6 text-center shadow-xl">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-neutral-950 text-white">
                    {officeBusy || canRenderOffice ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Sparkles className="h-5 w-5" />
                    )}
                  </div>
                  <div className="mt-4 text-base font-semibold text-neutral-950">
                    {officeError && !canRenderOffice ? 'Star Office 未连接' : '正在打开 Star Office'}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-neutral-500">
                    {officeError && !canRenderOffice
                      ? officeError
                      : `正在确认本地服务 ${officeUrl}，准备好后会自动显示办公室。`}
                  </p>
                  {officeError && !canRenderOffice && (
                    <button
                      type="button"
                      onClick={reloadOffice}
                      className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800"
                    >
                      <RefreshCw className="h-4 w-4" />
                      重试连接
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function OfficeMenuButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition',
        active ? 'bg-neutral-950 text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function SessionBindButton({
  active,
  language,
  session,
  onClick,
}: {
  active: boolean
  language: 'zh' | 'en'
  session: Session
  onClick: () => void
}) {
  const Icon = session.type === 'group' ? Users : MessageCircle
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition',
        active
          ? 'border-neutral-950 bg-neutral-950 text-white'
          : 'border-neutral-200 bg-white text-neutral-900 hover:border-neutral-300 hover:bg-neutral-50',
      )}
    >
      <span
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
          active ? 'bg-white/15 text-white' : 'bg-[#edf7f3] text-emerald-700',
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{session.title}</span>
        <span className={cn('mt-0.5 flex items-center gap-1 truncate text-xs', active ? 'text-white/65' : 'text-neutral-500')}>
          <Clock className="h-3 w-3 shrink-0" />
          {sessionTypeText(session)} · {relativeTime(session.updatedAt, language)}
        </span>
      </span>
    </button>
  )
}

function ConnectionBadge({ running, busy, loaded }: { running: boolean; busy: boolean; loaded: boolean }) {
  const connected = running && loaded
  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium',
        connected
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : running || busy
            ? 'border-amber-200 bg-amber-50 text-amber-700'
            : 'border-red-200 bg-red-50 text-red-600',
      )}
    >
      {connected ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <Loader2 className={cn('h-4 w-4', running || busy ? 'animate-spin' : '')} />
      )}
      {connected ? '已连接' : running || busy ? '连接中' : '未连接'}
    </div>
  )
}

function sessionTypeText(session: Session) {
  return session.type === 'group' ? '群聊' : '单聊'
}

function sessionDedupKey(session: Session) {
  const title = session.title.trim().replace(/\s+/g, ' ').toLowerCase()
  return `${session.type}:${title || session.id}`
}
