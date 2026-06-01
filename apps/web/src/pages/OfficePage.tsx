import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  PanelLeft,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import { api, friendlyErrorMessage, type StarOfficeStatus } from '../lib/api'
import { cn } from '../lib/utils'
import { useChatStore } from '../stores/chatStore'

const DEFAULT_STAR_OFFICE_URL = 'http://127.0.0.1:19000'

export default function OfficePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const sessions = useChatStore((state) => state.sessions)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [officeBusy, setOfficeBusy] = useState(false)
  const [officeError, setOfficeError] = useState<string | null>(null)
  const [officeStatus, setOfficeStatus] = useState<StarOfficeStatus | null>(null)
  const sessionFromUrl = searchParams.get('session')
  const [boundSessionId, setBoundSessionId] = useState<string | null>(sessionFromUrl)

  const boundSession =
    sessions.find((s) => s.id === boundSessionId) ??
    sessions.find((s) => s.id === currentSessionId) ??
    null
  const officeUrl = officeStatus?.url ?? DEFAULT_STAR_OFFICE_URL
  const canRenderOffice = Boolean(officeStatus?.running)

  useEffect(() => {
    void useChatStore.getState().fetchSessions()
  }, [])

  useEffect(() => {
    void ensureOffice()
  }, [])

  // 加入当前绑定会话的所有 workspace agents 到办公室
  useEffect(() => {
    if (!boundSession?.id || !canRenderOffice) return
    api.joinOfficeAgents(boundSession.id).catch(() => {})
  }, [boundSession?.id, canRenderOffice])

  useEffect(() => {
    if (boundSessionId && sessions.some((s) => s.id === boundSessionId)) return
    if (currentSessionId && sessions.some((s) => s.id === currentSessionId)) {
      setBoundSessionId(currentSessionId)
      return
    }
    setBoundSessionId(sessions[0]?.id ?? null)
  }, [sessions, boundSessionId, currentSessionId])

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
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((v) => !v)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            {boundSession && (
              <button
                type="button"
                onClick={() => navigate(`/chat/${boundSession.id}`)}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
                title="返回会话"
                aria-label="返回会话"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf7f3] text-emerald-700">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-950">Star Office</div>
              <div className="truncate text-xs text-neutral-500">
                {boundSession ? boundSession.title : '未绑定会话'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reloadOffice}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
              title="重新连接"
              aria-label="重新连接"
            >
              {officeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
            <a
              href={officeUrl}
              target="_blank"
              rel="noreferrer"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
              title="新窗口打开"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <ConnectionBadge running={Boolean(officeStatus?.running)} busy={officeBusy} loaded={loaded} />
          </div>
        </header>

        <div className="agenthub-embedded-frame relative min-h-0 flex-1 overflow-hidden bg-white">
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
      </main>
    </div>
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
