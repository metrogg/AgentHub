import { type ReactNode, useEffect, useState } from 'react'
import {
  Bot,
  Building2,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  PlayCircle,
  RefreshCw,
  Settings2,
  Users,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import { requestNewSessionDialog } from '../components/chat/GlobalNewSessionDialog'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { useWorkspaceStore } from '../stores/workspaceStore'

type OfficePanel = 'dashboard' | 'workspace'

export default function OfficePage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [activePanel, setActivePanel] = useState<OfficePanel>('dashboard')
  const [selectingWorkspaceId, setSelectingWorkspaceId] = useState<string | null>(null)
  const { workspaces, currentId, loadingList, fetchList, selectWorkspace } = useWorkspaceStore()
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentId) ?? null
  const [stats, setStats] = useState<{ sessions: number; agents: number; recentRuns: number }>({ sessions: 0, agents: 0, recentRuns: 0 })

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  useEffect(() => {
    if (!currentId) return
    api.listSessions().then((res) => setStats((s) => ({ ...s, sessions: res.items.length }))).catch(() => {})
  }, [currentId])

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
                <p className="truncate text-sm text-neutral-500">{t('工作区仪表盘')}</p>
              </div>
            </div>
          </div>

          <nav className="space-y-2 border-b border-neutral-200 p-3">
            <OfficeMenuButton
              active={activePanel === 'dashboard'}
              icon={<LayoutDashboard className="h-4 w-4" />}
              label={t('仪表盘')}
              onClick={() => setActivePanel('dashboard')}
            />
            <OfficeMenuButton
              active={activePanel === 'workspace'}
              icon={<FolderOpen className="h-4 w-4" />}
              label={t('切换工作区')}
              onClick={() => setActivePanel('workspace')}
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
                    {currentWorkspace?.projectPath ?? t('请选择一个工作区')}
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
                    subtitle={t('仅查看全局状态')}
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
              <section className="space-y-4">
                <div className="text-sm font-semibold text-neutral-900">{t('快速操作')}</div>
                <QuickAction
                  icon={<MessageSquare className="h-4 w-4" />}
                  label={t('新建对话')}
                  onClick={() => navigate('/chat')}
                />
                <QuickAction
                  icon={<Bot className="h-4 w-4" />}
                  label={t('Agent 配置')}
                  onClick={() => navigate('/agent-config')}
                />
                <QuickAction
                  icon={<GitBranch className="h-4 w-4" />}
                  label={t('编排任务')}
                  onClick={() => navigate('/orchestrator-runs')}
                />
                <QuickAction
                  icon={<Settings2 className="h-4 w-4" />}
                  label={t('系统设置')}
                  onClick={() => navigate('/settings')}
                />
              </section>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[#f5f4ef] p-6">
          <header className="mb-6 flex h-12 shrink-0 items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf7f3] text-emerald-700">
                <LayoutDashboard className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-neutral-950">
                  {currentWorkspace?.name ?? t('Agent Hub 仪表盘')}
                </div>
                <div className="truncate text-sm text-neutral-500">
                  {currentWorkspace ? t('已关联 {name}').replace('{name}', currentWorkspace.name) : t('未关联工作区')}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void fetchList()}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('刷新')}
            </button>
          </header>

          <div className="grid flex-1 content-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              icon={<MessageSquare className="h-5 w-5 text-blue-600" />}
              label={t('会话总数')}
              value={stats.sessions}
              onClick={() => navigate('/chat')}
            />
            <StatCard
              icon={<Users className="h-5 w-5 text-emerald-600" />}
              label={t('Agent 数量')}
              value={stats.agents}
              onClick={() => navigate('/agent-config')}
            />
            <StatCard
              icon={<PlayCircle className="h-5 w-5 text-purple-600" />}
              label={t('编排任务')}
              value={stats.recentRuns}
              onClick={() => navigate('/orchestrator-runs')}
            />
          </div>

          <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="text-sm font-semibold text-neutral-900">{t('开始使用')}</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ActionCard
                icon={<MessageSquare className="h-5 w-5" />}
                title={t('新建对话')}
                desc={t('与 Agent 一对一对话')}
                onClick={() => navigate('/chat')}
              />
              <ActionCard
                icon={<Users className="h-5 w-5" />}
                title={t('创建群聊')}
                desc={t('多 Agent 协作')}
                onClick={() => requestNewSessionDialog()}
              />
              <ActionCard
                icon={<Bot className="h-5 w-5" />}
                title={t('配置 Agent')}
                desc={t('管理 Agent 通讯录')}
                onClick={() => navigate('/agent-config')}
              />
              <ActionCard
                icon={<GitBranch className="h-5 w-5" />}
                title={t('编排任务')}
                desc={t('查看运行历史')}
                onClick={() => navigate('/orchestrator-runs')}
              />
            </div>
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

function QuickAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 w-full items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 text-left text-sm font-medium text-neutral-700 transition hover:border-neutral-300 hover:bg-neutral-50"
    >
      {icon}
      {label}
    </button>
  )
}

function StatCard({ icon, label, value, onClick }: { icon: ReactNode; label: string; value: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-neutral-200 bg-white p-5 text-left shadow-sm transition hover:border-neutral-300 hover:shadow-md"
    >
      <div className="flex items-center gap-3">
        {icon}
        <span className="text-sm text-neutral-500">{label}</span>
      </div>
      <div className="mt-3 text-3xl font-semibold text-neutral-950">{value}</div>
    </button>
  )
}

function ActionCard({ icon, title, desc, onClick }: { icon: ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-[#fafaf7] p-4 text-left transition hover:border-neutral-300 hover:bg-white"
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-950 text-white">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-neutral-950">{title}</div>
        <div className="mt-0.5 text-xs text-neutral-500">{desc}</div>
      </div>
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
