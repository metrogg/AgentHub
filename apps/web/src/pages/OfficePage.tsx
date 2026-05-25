import { type ReactNode, useEffect, useState } from 'react'
import {
  Building2,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { useI18n } from '../lib/i18n'
import { useWorkspaceStore } from '../stores/workspaceStore'

const STAR_OFFICE_URL = 'http://127.0.0.1:19000'

type OfficePanel = 'workspace' | 'settings'

export default function OfficePage() {
  const { t } = useI18n()
  const [frameKey, setFrameKey] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [activePanel, setActivePanel] = useState<OfficePanel>('workspace')
  const [selectingWorkspaceId, setSelectingWorkspaceId] = useState<string | null>(null)
  const { workspaces, currentId, loadingList, fetchList, selectWorkspace } = useWorkspaceStore()
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentId) ?? null

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  function reloadOffice() {
    setLoaded(false)
    setFrameKey((current) => current + 1)
  }

  async function handleWorkspaceSelect(workspaceId: string | null) {
    setSelectingWorkspaceId(workspaceId ?? 'none')
    try {
      await selectWorkspace(workspaceId)
    } finally {
      setSelectingWorkspaceId(null)
    }
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f5f4ef] text-neutral-950">
      <SessionList />

      <main className="flex min-w-0 flex-1 overflow-hidden">
        <aside className="flex h-full w-72 shrink-0 flex-col border-r border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-950 text-white">
                <Building2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold tracking-normal">{t('办公室')}</h1>
                <p className="truncate text-sm text-neutral-500">{t('Agent Hub 监控面板')}</p>
              </div>
            </div>
          </div>

          <nav className="space-y-2 border-b border-neutral-200 p-3">
            <OfficeMenuButton
              active={activePanel === 'workspace'}
              icon={<FolderOpen className="h-4 w-4" />}
              label={t('切换工作区')}
              onClick={() => setActivePanel('workspace')}
            />
            <OfficeMenuButton
              active={activePanel === 'settings'}
              icon={<Settings2 className="h-4 w-4" />}
              label={t('设置办公室')}
              onClick={() => setActivePanel('settings')}
            />
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {activePanel === 'workspace' ? (
              <section>
                <div className="text-sm font-semibold text-neutral-900">{t('当前工作区')}</div>
                <div className="mt-3 rounded-lg border border-neutral-200 bg-[#fafaf7] p-3">
                  <div className="truncate text-sm font-medium text-neutral-950">
                    {currentWorkspace?.name ?? t('未绑定工作区')}
                  </div>
                  <div className="mt-1 truncate text-sm text-neutral-500" title={currentWorkspace?.projectPath ?? ''}>
                    {currentWorkspace?.projectPath ?? t('Star Office 将独立运行')}
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <div className="text-sm font-semibold text-neutral-900">{t('工作区列表')}</div>
                  {loadingList && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
                </div>

                <div className="mt-3 space-y-2">
                  <WorkspaceButton
                    active={!currentId}
                    loading={selectingWorkspaceId === 'none'}
                    title={t('不绑定工作区')}
                    subtitle={t('只查看办公室状态')}
                    onClick={() => void handleWorkspaceSelect(null)}
                  />
                  {workspaces.map((workspace) => (
                    <WorkspaceButton
                      key={workspace.id}
                      active={workspace.id === currentId}
                      loading={selectingWorkspaceId === workspace.id}
                      title={workspace.name}
                      subtitle={workspace.projectPath ?? t('未设置项目文件夹')}
                      onClick={() => void handleWorkspaceSelect(workspace.id)}
                    />
                  ))}
                  {!loadingList && workspaces.length === 0 && (
                    <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-sm text-neutral-500">
                      {t('暂无工作区')}
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section>
                <div className="text-sm font-semibold text-neutral-900">{t('办公室设置')}</div>
                <div className="mt-3 grid gap-2">
                  <button
                    type="button"
                    onClick={reloadOffice}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:border-neutral-300 hover:bg-neutral-50"
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t('刷新办公室')}
                  </button>
                  <a
                    href={STAR_OFFICE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-neutral-950 text-sm font-semibold text-white transition hover:bg-neutral-800"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('新窗口打开')}
                  </a>
                </div>

                <div className="mt-5 rounded-lg border border-neutral-200 bg-[#fafaf7] p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    {t('资产侧边栏')}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-neutral-600">
                    {t('默认验证码是')} <span className="font-semibold text-neutral-950">1234</span>{t('。长期运行时建议在 Star Office 后台改为强密码。')}
                  </p>
                </div>

                <div className="mt-5 rounded-lg border border-neutral-200 bg-[#fafaf7] p-3">
                  <div className="text-sm font-semibold text-neutral-900">{t('服务地址')}</div>
                  <div className="mt-2 break-all rounded-md bg-white px-2 py-2 text-sm text-neutral-600">
                    {STAR_OFFICE_URL}
                  </div>
                </div>
              </section>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[#f5f4ef] p-4">
          <header className="mb-3 flex h-12 shrink-0 items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf7f3] text-emerald-700">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-neutral-950">Agent Hub Office</div>
                <div className="truncate text-sm text-neutral-500">
                  {currentWorkspace ? t('已关联 {name}').replace('{name}', currentWorkspace.name) : t('未关联 AgentHub 工作区')}
                </div>
              </div>
            </div>
            <div className="inline-flex shrink-0 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
              {loaded ? <CheckCircle2 className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
              {loaded ? t('已连接') : t('连接中')}
            </div>
          </header>

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
            {!loaded && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-white/90 backdrop-blur-sm">
                <div className="w-[22rem] rounded-lg border border-neutral-200 bg-white p-6 text-center shadow-xl">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-neutral-950 text-white">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div className="mt-4 text-base font-semibold text-neutral-950">{t('正在打开 Star Office')}</div>
                  <p className="mt-2 text-sm leading-6 text-neutral-500">
                    {t('后端应运行在 {url}。如果长时间停留，请确认 Star Office 后端已启动。').replace('{url}', STAR_OFFICE_URL)}
                  </p>
                </div>
              </div>
            )}

            <iframe
              key={frameKey}
              title="Star Office UI"
              src={STAR_OFFICE_URL}
              onLoad={() => setLoaded(true)}
              className="h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write"
            />
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
      className={[
        'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition',
        active ? 'bg-neutral-950 text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950',
      ].join(' ')}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function WorkspaceButton({
  active,
  loading,
  title,
  subtitle,
  onClick,
}: {
  active: boolean
  loading: boolean
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition',
        active
          ? 'border-neutral-950 bg-neutral-950 text-white'
          : 'border-neutral-200 bg-white text-neutral-900 hover:border-neutral-300 hover:bg-neutral-50',
      ].join(' ')}
    >
      <span
        className={[
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
          active ? 'bg-white/15 text-white' : 'bg-[#edf7f3] text-emerald-700',
        ].join(' ')}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{title}</span>
        <span className={['mt-0.5 block truncate text-sm', active ? 'text-white/65' : 'text-neutral-500'].join(' ')}>
          {subtitle}
        </span>
      </span>
    </button>
  )
}
