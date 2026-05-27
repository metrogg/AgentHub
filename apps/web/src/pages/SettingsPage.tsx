import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import {
  Activity,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Info,
  Keyboard,
  LockKeyhole,
  Loader2,
  MessageSquare,
  Monitor,
  QrCode,
  RefreshCw,
  Search,
  Server,
  Settings,
  Smartphone,
  TerminalSquare,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { api, type Message, type Session, type SettingsGeneralInfo } from '../lib/api'
import { accentColor, applyAppearanceSettings, fontStack, hexToRgba, readableAccentColor, resolveTheme, themePalette } from '../lib/appearance'
import { languageToSettingValue, normalizeLanguage, useI18n } from '../lib/i18n'
import { getDesktopInfo, isDesktopApp, openPath, pickWorkspaceFolder } from '../lib/native'
import { loadSessionListPrefs, saveSessionListPrefs, sessionArchiveChangeEvent } from '../lib/sessionArchive'
import {
  defaultShortcutBindings,
  normalizeShortcutBindings,
  settingsUpdatedEvent,
  shortcutConflict,
  shortcutFromRecordingEvent,
  type ShortcutActionId,
} from '../lib/shortcuts'
import { cn, relativeTime } from '../lib/utils'

type SectionKey =
  | '通用'
  | '显示'
  | '快捷键'
  | '工具权限'
  | '归档会话'
  | '控制台'
  | '关于'

const sections: Array<{ icon: typeof Settings; label: SectionKey }> = [
  { icon: Settings, label: '通用' },
  { icon: Monitor, label: '显示' },
  { icon: Keyboard, label: '快捷键' },
  { icon: LockKeyhole, label: '工具权限' },
  { icon: Archive, label: '归档会话' },
  { icon: TerminalSquare, label: '控制台' },
  { icon: Info, label: '关于' },
]

interface AppSettings {
  startupPage: string
  language: string
  autoSave: boolean
  compactMode: boolean
  theme: string
  accent: string
  fontSize: string
  bubbleStyle: string
  personality: string
  responseDepth: string
  planBeforeAct: boolean
  shortcuts: Array<{ action: string; keys: string }>
  mcpServers: Array<{ id: string; name: string; command: string; enabled: boolean }>
  hooks: Array<{ id: string; event: string; command: string; enabled: boolean }>
  connections: Array<{ id: string; name: string; url: string; status: string }>
  gitAutoDetect: boolean
  gitAuthor: string
  gitEmail: string
  envVars: Array<{ id: string; key: string; value: string }>
  worktreeRoot: string
  isolateWorktrees: boolean
  browserProvider: string
  browserViewport: string
  computerControl: boolean
  requireApproval: boolean
  archivedRetention: string
  debugMode: boolean
  dataPath: string
  dataUsed: string
  gitRuntime: string
  gitPath: string
  pythonRuntime: string
  pythonPath: string
  mainWindowTheme: string
  autoOpenTodo: boolean
  autoOpenFileChanges: boolean
  autoCloseFileChanges: boolean
  userMessagesRight: boolean
  collapseCompletedTools: boolean
  hideCompletedThoughts: boolean
  gitColoredStatus: boolean
  hideGitCandidates: boolean
  notifyBackground: boolean
  notifyCompletion: boolean
  notifyInputRequired: boolean
  notifyError: boolean
  notifyConfirmation: boolean
  uiFont: string
  bodyFont: string
  inlineCodeFont: string
  codeBlockFont: string
  terminalFont: string
  sendMode: string
  toolPermissionMode: string
  toolPermissions: Record<string, string>
  accountName: string
  accountAvatar: string
}

const defaultAppSettings: AppSettings = {
  startupPage: '上次会话',
  language: '中文',
  autoSave: true,
  compactMode: false,
  theme: '浅色',
  accent: '黑色',
  fontSize: '14',
  bubbleStyle: '简洁',
  personality: '温和理性',
  responseDepth: '自动',
  planBeforeAct: true,
  shortcuts: [
    { action: '发送消息', keys: 'Enter' },
    { action: '换行', keys: 'Shift Enter' },
    { action: '打开命令菜单', keys: 'Ctrl K' },
    { action: '新建会话', keys: 'Ctrl N' },
  ],
  mcpServers: [
    { id: 'filesystem', name: 'Filesystem', command: 'npx @modelcontextprotocol/server-filesystem .', enabled: true },
    { id: 'git', name: 'Git', command: 'uvx mcp-server-git', enabled: false },
  ],
  hooks: [
    { id: 'before-tool', event: '工具调用前', command: 'echo review-permission', enabled: true },
    { id: 'after-message', event: '消息完成后', command: 'echo save-artifact', enabled: false },
  ],
  connections: [
    { id: 'github', name: 'GitHub', url: 'https://github.com', status: '未连接' },
    { id: 'vercel', name: 'Vercel', url: 'https://vercel.com', status: '未连接' },
  ],
  gitAutoDetect: true,
  gitAuthor: 'AgentHub',
  gitEmail: '771473941@qq.com',
  envVars: [
    { id: 'openai', key: 'OPENAI_API_KEY', value: '' },
    { id: 'anthropic', key: 'ANTHROPIC_API_KEY', value: '' },
  ],
  worktreeRoot: 'F:\\Learning\\AgentHub\\.worktrees',
  isolateWorktrees: true,
  browserProvider: '内置浏览器',
  browserViewport: '1440x900',
  computerControl: false,
  requireApproval: true,
  archivedRetention: '90 天',
  debugMode: false,
  dataPath: 'F:\\Learning\\AgentHub\\data',
  dataUsed: '1.78 GB',
  gitRuntime: 'PATH Git git version 2.51.0.windows.1',
  gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
  pythonRuntime: '托管 Python 3.13.12',
  pythonPath: 'F:\\Learning\\AgentHub\\managed-python\\windows-x64\\python.exe',
  mainWindowTheme: '跟随系统',
  autoOpenTodo: true,
  autoOpenFileChanges: true,
  autoCloseFileChanges: true,
  userMessagesRight: true,
  collapseCompletedTools: true,
  hideCompletedThoughts: true,
  gitColoredStatus: true,
  hideGitCandidates: false,
  notifyBackground: true,
  notifyCompletion: true,
  notifyInputRequired: true,
  notifyError: true,
  notifyConfirmation: true,
  uiFont: '默认',
  bodyFont: '默认',
  inlineCodeFont: '默认',
  codeBlockFont: '默认',
  terminalFont: '默认',
  sendMode: 'Enter 发送',
  toolPermissionMode: 'Auto',
  toolPermissions: {
    read: 'Auto',
    grep: 'Auto',
    list: 'Auto',
    task: 'Ask',
    todowrite: 'Auto',
    ask_user_question: 'Ask',
    unity_yaml_search: 'Auto',
    unity_yaml_read: 'Auto',
    knowledge_list: 'Auto',
    knowledge_query: 'Auto',
    knowledge_read: 'Auto',
    knowledge_create: 'Auto',
    knowledge_delete: 'Ask',
    knowledge_move: 'Auto',
    knowledge_edit: 'Ask',
  },
  accountName: 'You',
  accountAvatar: '',
}

const themeModes = ['跟随系统', '亮色', '暗色']
const accentOptions = ['黑色', '蓝色', '绿色', '琥珀色']
const fontOptions = ['默认', 'Aptos', 'Microsoft YaHei UI', 'Noto Sans SC', 'LXGW WenKai', 'JetBrains Mono', 'Cascadia Mono']
const fontSizeOptions = ['13', '14', '15', '16', '18']
const messageStyleOptions = ['紧凑', '简洁', '气泡']

export default function SettingsPage() {
  const navigate = useNavigate()
  return <SettingsSurface onClose={() => navigate(-1)} />
}

export function SettingsSurface({
  onClose,
  compact = false,
  showSidebarClose = true,
}: {
  onClose: () => void
  compact?: boolean
  showSidebarClose?: boolean
}) {
  const { setLanguage, t } = useI18n()
  const [activeSection, setActiveSection] = useState<SectionKey>('通用')
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    applyAppearanceSettings(appSettings)
  }, [
    appSettings.accent,
    appSettings.bodyFont,
    appSettings.codeBlockFont,
    appSettings.fontSize,
    appSettings.inlineCodeFont,
    appSettings.mainWindowTheme,
    appSettings.terminalFont,
    appSettings.uiFont,
  ])

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        if (settings.APP_SETTINGS) {
          try {
            const parsed = JSON.parse(settings.APP_SETTINGS) as Partial<AppSettings>
            const normalizedLanguage = normalizeLanguage(parsed.language)
            setLanguage(normalizedLanguage)
            setAppSettings({
              ...defaultAppSettings,
              ...parsed,
              language: languageToSettingValue(normalizedLanguage),
              shortcuts: normalizeShortcutBindings(parsed.shortcuts),
            })
          } catch {
            setAppSettings(defaultAppSettings)
          }
        }
        if (settings.TOOL_PERMISSION_MODE || settings.TOOL_PERMISSION_RULES) {
          let parsedPermissions: Record<string, string> | null = null
          if (settings.TOOL_PERMISSION_RULES) {
            try {
              const parsed = JSON.parse(settings.TOOL_PERMISSION_RULES) as Record<string, string>
              if (parsed && typeof parsed === 'object') parsedPermissions = parsed
            } catch {
              parsedPermissions = null
            }
          }
          setAppSettings((current) => ({
            ...current,
            ...(settings.TOOL_PERMISSION_MODE ? { toolPermissionMode: settings.TOOL_PERMISSION_MODE } : {}),
            ...(parsedPermissions ? { toolPermissions: { ...current.toolPermissions, ...parsedPermissions } } : {}),
          }))
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading) return
    const timer = window.setTimeout(() => {
      setSaveState('saving')
      void api.saveSettings({
        APP_SETTINGS: JSON.stringify(appSettings),
        TOOL_PERMISSION_MODE: appSettings.toolPermissionMode,
        TOOL_PERMISSION_RULES: JSON.stringify(appSettings.toolPermissions),
      })
        .then(() => {
          window.dispatchEvent(new Event(settingsUpdatedEvent))
          setSaveState('saved')
          window.setTimeout(() => setSaveState('idle'), 2500)
        })
        .catch(() => setSaveState('error'))
    }, 650)
    return () => window.clearTimeout(timer)
  }, [appSettings, loading])

  function patchSettings(patch: Partial<AppSettings>) {
    setAppSettings((current) => ({ ...current, ...patch }))
  }

  const settingsThemeStyle = createSettingsThemeStyle(appSettings)

  return (
    <div className="settings-theme flex h-full min-h-0 overflow-hidden" style={settingsThemeStyle}>
      <SettingsSidebar
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        navigateBack={onClose}
        compact={compact}
        showClose={showSidebarClose}
      />

      <main
        className={cn('min-h-0 flex-1 overflow-y-auto', compact ? 'px-6 py-5' : 'px-10 py-9')}
        style={{ background: 'var(--settings-bg)', color: 'var(--settings-text)' }}
      >
        <div className={compact ? 'max-w-4xl' : 'max-w-6xl'}>
          <div className={cn('flex items-start justify-between gap-4', compact ? 'mb-5' : 'mb-8')}>
            <div>
              <h1 className={cn('font-semibold tracking-normal', compact ? 'text-xl' : 'text-2xl')} style={{ color: 'var(--settings-text)' }}>{t(activeSection)}</h1>
              <p className="mt-1 text-sm" style={{ color: 'var(--settings-muted-text)' }}>{t(sectionDescription(activeSection))}</p>
            </div>
            <AutoSaveStatus state={saveState} />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--settings-muted-text)' }}>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('加载中...')}
            </div>
          ) : (
            <SettingsContent
              section={activeSection}
              settings={appSettings}
              patchSettings={patchSettings}
              setLanguage={setLanguage}
            />
          )}
        </div>
      </main>

    </div>
  )
}

function SettingsSidebar({
  activeSection,
  setActiveSection,
  navigateBack,
  compact = false,
  showClose = true,
}: {
  activeSection: SectionKey
  setActiveSection: (section: SectionKey) => void
  navigateBack: () => void
  compact?: boolean
  showClose?: boolean
}) {
  const { t } = useI18n()
  return (
    <aside
      className={cn('h-full shrink-0 overflow-hidden border-r', compact ? 'w-[220px] px-4 py-4' : 'w-[260px] px-5 py-5')}
      style={{ background: 'var(--settings-sidebar)', borderColor: 'var(--settings-border)' }}
    >
      <div className={cn('flex items-center justify-between px-1', compact ? 'mb-5' : 'mb-7')}>
        <div className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t('设置')}</div>
        {showClose && (
          <button
            type="button"
            onClick={navigateBack}
            className="grid h-6 w-6 place-items-center rounded-md transition hover:brightness-95"
            style={{ color: 'var(--settings-muted-text)' }}
            aria-label={t('关闭设置')}
            title={t('关闭设置')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <nav className={compact ? 'space-y-2' : 'space-y-3'}>
        {sections.map((section) => (
          <button
            key={section.label}
            onClick={() => setActiveSection(section.label)}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-lg border px-2.5 text-sm font-medium transition hover:-translate-y-px',
              activeSection === section.label ? 'shadow-sm' : 'border-transparent'
            )}
            style={{
              background: activeSection === section.label ? 'var(--settings-active-bg)' : 'transparent',
              borderColor: activeSection === section.label ? 'var(--settings-active-border)' : 'transparent',
              color: activeSection === section.label ? 'var(--settings-accent)' : 'var(--settings-muted-text)',
            }}
          >
            <section.icon className="h-4 w-4" style={{ color: activeSection === section.label ? 'var(--settings-accent)' : 'var(--settings-muted)' }} />
            {t(section.label)}
          </button>
        ))}
      </nav>
    </aside>
  )
}

function SettingsContent({
  section,
  settings,
  patchSettings,
  setLanguage,
}: {
  section: SectionKey
  settings: AppSettings
  patchSettings: (patch: Partial<AppSettings>) => void
  setLanguage: (language: 'zh' | 'en') => void
}) {
  const { t } = useI18n()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [generalInfo, setGeneralInfo] = useState<SettingsGeneralInfo | null>(null)

  function patchLanguage(value: string) {
    const next = normalizeLanguage(value)
    setLanguage(next)
    patchSettings({ language: languageToSettingValue(next) })
  }

  useEffect(() => {
    if (section !== '通用') return
    let cancelled = false
    async function hydrateGeneralInfo() {
      try {
        const [info, desktopInfo] = await Promise.all([api.getSettingsGeneralInfo().catch(() => null), getDesktopInfo().catch(() => null)])
        if (cancelled) return
        if (info) setGeneralInfo(info)
        const patch: Partial<AppSettings> = {}
        if (info?.git) {
          patch.gitRuntime = info.git.runtime
          patch.gitPath = info.git.path
        }
        if (info?.python) {
          patch.pythonRuntime = info.python.runtime
          patch.pythonPath = info.python.path
        }
        if (info?.storage) {
          patch.dataPath = info.storage.dataPath
          patch.dataUsed = info.storage.sizeLabel
        } else if (desktopInfo && settings.dataPath === defaultAppSettings.dataPath) {
          patch.dataPath = desktopInfo.app_data_dir
        }
        if (Object.keys(patch).length) patchSettings(patch)
      } catch {
        // Optional diagnostics; the manual refresh buttons surface errors.
      }
    }
    void hydrateGeneralInfo()
    return () => {
      cancelled = true
    }
  }, [section, settings.dataPath])

  function showActionMessage(message: string) {
    setActionMessage(message)
    window.setTimeout(() => setActionMessage(''), 2200)
  }

  async function runAction(key: string, action: () => Promise<void>) {
    if (busyAction) return
    setBusyAction(key)
    try {
      await action()
    } catch (error: any) {
      showActionMessage(error?.message || t('操作失败'))
    } finally {
      setBusyAction(null)
    }
  }

  async function refreshRuntimeInfo() {
    const info = await api.getSettingsGeneralInfo()
    setGeneralInfo(info)
    patchSettings({
      gitRuntime: info.git.runtime,
      gitPath: info.git.path,
      pythonRuntime: info.python.runtime,
      pythonPath: info.python.path,
      dataUsed: info.storage.sizeLabel,
    })
    showActionMessage(t('运行时信息已刷新'))
  }

  async function refreshGeneralInfo() {
    const info = await api.getSettingsGeneralInfo()
    setGeneralInfo(info)
    patchSettings({
      dataPath: info.storage.dataPath,
      dataUsed: info.storage.sizeLabel,
      gitRuntime: info.git.runtime,
      gitPath: info.git.path,
      pythonRuntime: info.python.runtime,
      pythonPath: info.python.path,
    })
    showActionMessage(t('诊断信息已刷新'))
  }

  async function openDataDirectory() {
    await openPathWithFallback(settings.dataPath)
    showActionMessage(t('已打开数据目录'))
  }

  async function openConfiguredPath(path: string | undefined, successMessage: string) {
    if (!path) throw new Error(t('路径尚未就绪'))
    await openPathWithFallback(path)
    showActionMessage(t(successMessage))
  }

  async function openPathWithFallback(path: string) {
    const opened = await openPath(path)
    if (opened) return
    await api.openLocalPath(path)
  }

  async function openDebugDirectory() {
    const target = generalInfo?.debug.dir
    if (!target) throw new Error(t('调试目录尚未生成'))
    await openPathWithFallback(target)
    showActionMessage(t('已打开调试目录'))
  }

  async function changeDataDirectory() {
    const path = isDesktopApp()
      ? await pickWorkspaceFolder()
      : window.prompt(t('请输入本机数据目录路径'), settings.dataPath)
    if (!path) {
      showActionMessage(t('已取消选择'))
      return
    }
    patchSettings({ dataPath: path })
    showActionMessage(t('数据目录已更新，重启后生效'))
  }

  async function createDataDirectory() {
    const result = await api.ensureStorageDirectory(settings.dataPath)
    patchSettings({ dataPath: result.path, dataUsed: result.sizeLabel })
    await refreshGeneralInfo()
    showActionMessage(t('目录已创建'))
  }

  function restoreActiveDataDirectory() {
    const activeDataDir = generalInfo?.storage.activeDataDir
    if (!activeDataDir) return
    patchSettings({ dataPath: activeDataDir })
    showActionMessage(t('已恢复为当前生效目录'))
  }

  function patchDebugMode(debugMode: boolean) {
    patchSettings({ debugMode })
    setGeneralInfo((current) => current ? { ...current, debug: { ...current.debug, enabled: debugMode } } : current)
  }

  function updateAccountAvatar(file: File | null) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      showActionMessage('请选择图片文件')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      showActionMessage('头像图片不能超过 2 MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      patchSettings({ accountAvatar: String(reader.result || '') })
      showActionMessage('头像已更新')
    }
    reader.onerror = () => showActionMessage('读取头像失败')
    reader.readAsDataURL(file)
  }

  function resetAllSettings() {
    patchSettings(defaultAppSettings)
    setLanguage('zh')
    showActionMessage(t('已恢复默认设置'))
  }

  switch (section) {
    case '通用':
      return (
        <SettingsStack>
          {actionMessage && <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600 shadow-sm">{actionMessage}</div>}
          <SettingsSection title="账号资料" desc="配置本机账号在 Web、桌面端左侧导航和“我的”页面中显示的名称与头像。">
            <InsetPanel>
              <div className="flex flex-wrap items-center gap-4">
                <AccountAvatarPreview name={settings.accountName} avatar={settings.accountAvatar} size="large" />
                <div className="min-w-0 flex-1 space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--settings-muted-text)' }}>显示名称</span>
                    <input
                      value={settings.accountName}
                      onChange={(event) => patchSettings({ accountName: event.target.value })}
                      className="settings-input"
                      maxLength={32}
                      placeholder="You"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <label className="settings-soft-button cursor-pointer">
                      上传头像
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                          updateAccountAvatar(event.currentTarget.files?.[0] ?? null)
                          event.currentTarget.value = ''
                        }}
                      />
                    </label>
                    <button type="button" className="settings-soft-button" onClick={() => patchSettings({ accountAvatar: '' })}>
                      移除头像
                    </button>
                  </div>
                </div>
              </div>
            </InsetPanel>
          </SettingsSection>
          <SettingsSection title="界面语言" desc="切换界面显示语言">
            <SegmentedControl value={languageToSettingValue(normalizeLanguage(settings.language))} options={['中文', 'English']} onChange={patchLanguage} />
          </SettingsSection>
          <SettingsSection title="移动端扫码连接" desc="让手机在同一局域网内扫码连接这台电脑的 AgentHub。二维码 2 分钟有效，用后即失效。">
            <MobilePairingPanel />
          </SettingsSection>
          <SettingsSection
            title="调试模式"
            desc="开启后，每次模型 HTTP 请求会被保存到调试目录。Authorization 等敏感请求头会自动脱敏。"
          >
            <InsetPanel>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <InlineSwitch checked={settings.debugMode} onChange={patchDebugMode} label={settings.debugMode ? '已开启' : '已关闭'} />
                <StatusPill ok={settings.debugMode} label={settings.debugMode ? '正在记录调试信息' : '不会记录模型请求'} />
              </div>
              <InfoRow label="调试目录" value={generalInfo?.debug.dir ?? t('等待刷新')} />
              <InfoRow label="日志级别" value={generalInfo?.debug.logLevel ?? (settings.debugMode ? 'debug' : 'info')} />
              <InfoRow label="调试文件大小" value={generalInfo?.debug.sizeLabel ?? '0 B'} />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busyAction === 'debug-dir'} onClick={() => void runAction('debug-dir', openDebugDirectory)} className="settings-soft-button">{t('打开调试目录')}</button>
                <button type="button" disabled={busyAction === 'general-info'} onClick={() => void runAction('general-info', refreshGeneralInfo)} className="settings-soft-button">{t('刷新状态')}</button>
              </div>
            </InsetPanel>
          </SettingsSection>
          <SettingsSection
            title="本地数据存储"
            desc="会话与记忆文件存放在这里；Knowledge 保留在项目目录中。可打开当前目录或迁移到新位置，迁移会在重启后完成。"
          >
            <InsetPanel>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  <StatusPill ok={generalInfo?.storage.exists ?? Boolean(settings.dataPath)} label={(generalInfo?.storage.exists ?? Boolean(settings.dataPath)) ? '目录可用' : '目录不可用'} />
                  {generalInfo?.storage.migrationPending && <StatusPill ok={false} label="重启后迁移" />}
                </div>
                <button type="button" disabled={busyAction === 'general-info'} onClick={() => void runAction('general-info', refreshGeneralInfo)} className="settings-soft-button">{busyAction === 'general-info' ? t('刷新中') : t('重新计算占用')}</button>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <StorageMetric label="已用空间" value={settings.dataUsed} />
                <StorageMetric label="数据库大小" value={generalInfo?.storage.databaseSizeLabel ?? '0 B'} />
                <StorageMetric label="扫描文件" value={generalInfo?.storage.scannedFiles !== undefined ? String(generalInfo.storage.scannedFiles) : t('等待刷新')} />
              </div>

              <InfoRow label="选择的数据目录" value={settings.dataPath} />
              <InfoRow label="当前生效目录" value={generalInfo?.storage.activeDataDir ?? t('等待刷新')} />
              <InfoRow label="App Data" value={generalInfo?.storage.appDataDir ?? t('等待刷新')} />
              <InfoRow label="配置目录" value={generalInfo?.storage.configDir ?? t('等待刷新')} />
              <InfoRow label="日志目录" value={generalInfo?.storage.logDir ?? t('等待刷新')} />
              <InfoRow label="数据库文件" value={generalInfo?.storage.databasePath ?? t('等待刷新')} />
              {generalInfo?.storage.migrationPending && (
                <Notice tone="warning">{t('已选择新的数据目录。当前运行中的服务仍使用当前生效目录，重启客户端后会切换。')}</Notice>
              )}
              {generalInfo?.storage.message && <Notice tone="warning">{generalInfo.storage.message}</Notice>}
              {generalInfo?.storage.truncated && <Notice tone="warning">{t('目录较大，已展示扫描上限内的估算体积')}</Notice>}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busyAction === 'open-data'} onClick={() => void runAction('open-data', openDataDirectory)} className="settings-soft-button">{t('打开目录')}</button>
                <button type="button" disabled={busyAction === 'change-data'} onClick={() => void runAction('change-data', changeDataDirectory)} className="settings-soft-button">{t('更改位置')}</button>
                {generalInfo?.storage.exists === false && <button type="button" disabled={busyAction === 'create-data'} onClick={() => void runAction('create-data', createDataDirectory)} className="settings-soft-button">{t('创建目录')}</button>}
                <button type="button" disabled={!generalInfo?.storage.activeDataDir || busyAction === 'open-active-data'} onClick={() => void runAction('open-active-data', () => openConfiguredPath(generalInfo?.storage.activeDataDir, '已打开当前生效目录'))} className="settings-soft-button">{t('打开生效目录')}</button>
                <button type="button" disabled={!generalInfo?.storage.configDir || busyAction === 'open-config'} onClick={() => void runAction('open-config', () => openConfiguredPath(generalInfo?.storage.configDir, '已打开配置目录'))} className="settings-soft-button">{t('打开配置目录')}</button>
                <button type="button" disabled={!generalInfo?.storage.logDir || busyAction === 'open-log'} onClick={() => void runAction('open-log', () => openConfiguredPath(generalInfo?.storage.logDir, '已打开日志目录'))} className="settings-soft-button">{t('打开日志目录')}</button>
                <button type="button" disabled={!generalInfo?.storage.databasePath || busyAction === 'open-db'} onClick={() => void runAction('open-db', () => openConfiguredPath(parentDirectory(generalInfo?.storage.databasePath), '已打开数据库所在目录'))} className="settings-soft-button">{t('打开数据库目录')}</button>
                {generalInfo?.storage.migrationPending && <button type="button" onClick={restoreActiveDataDirectory} className="settings-soft-button">{t('恢复当前生效目录')}</button>}
              </div>
            </InsetPanel>
          </SettingsSection>
          <SettingsSection title="GIT 运行时" desc="AgentHub 使用这个 Git 执行版本控制、撤销和变更分析。">
            <InsetPanel>
              <div className="flex items-center justify-between gap-3">
                <StatusPill ok={generalInfo?.git.ok ?? Boolean(settings.gitPath)} label={(generalInfo?.git.ok ?? Boolean(settings.gitPath)) ? '可用' : '不可用'} />
                <button type="button" disabled={busyAction === 'runtime'} onClick={() => void runAction('runtime', refreshRuntimeInfo)} className="settings-soft-button">{busyAction === 'runtime' ? t('刷新中') : t('刷新')}</button>
              </div>
              <RuntimeRow label="当前使用" value={settings.gitRuntime} />
              <InfoRow label="Git 路径" value={settings.gitPath} />
              {generalInfo?.git.message && <Notice tone="warning">{generalInfo.git.message}</Notice>}
            </InsetPanel>
          </SettingsSection>
          <SettingsSection title="PYTHON 运行时" desc="bash 工具调用 python 或 python3 时使用这里选择的解释器。">
            <InsetPanel>
              <div className="flex items-center justify-between gap-3">
                <StatusPill ok={generalInfo?.python.ok ?? Boolean(settings.pythonPath)} label={(generalInfo?.python.ok ?? Boolean(settings.pythonPath)) ? '可用' : '不可用'} />
                <button type="button" disabled={busyAction === 'runtime'} onClick={() => void runAction('runtime', refreshRuntimeInfo)} className="settings-soft-button">{busyAction === 'runtime' ? t('刷新中') : t('刷新')}</button>
              </div>
              <RuntimeRow label="当前选择" value={settings.pythonRuntime} />
              <InfoRow label="解释器路径" value={settings.pythonPath} />
              {generalInfo?.python.message && <Notice tone="warning">{generalInfo.python.message}</Notice>}
            </InsetPanel>
          </SettingsSection>
          <SettingsSection title="清空所有聊天记录" desc="删除当前账号下的所有会话和消息记录。此操作不可恢复。">
            <button
              type="button"
              disabled={busyAction === 'clear-all-sessions'}
              onClick={() => {
                if (!window.confirm('确定要删除所有聊天记录吗？此操作不可恢复。')) return
                void runAction('clear-all-sessions', async () => {
                  await api.deleteAllSessions()
                  showActionMessage('所有聊天记录已清空')
                })
              }}
              className="settings-danger-button"
            >
              {busyAction === 'clear-all-sessions' ? t('删除中...') : t('清空所有聊天记录')}
            </button>
          </SettingsSection>
          <SettingsSection title="重置所有设置" desc="清除当前配置并重新进入初始引导">
            <button type="button" onClick={resetAllSettings} className="settings-danger-button">{t('重置所有设置')}</button>
          </SettingsSection>
        </SettingsStack>
      )
    case '显示':
      return (
        <SettingsStack>
          <SettingsSection title="主题显示" desc="选择窗口颜色、强调色，并预览聊天与工具面板的显示效果。">
            <ThemeDisplayPanel
              settings={settings}
              patchSettings={patchSettings}
            />
          </SettingsSection>
          <SettingsSection title="GIT 视图">
            <SwitchList
              items={[
                ['层级视图用彩色图标显示修改状态', settings.gitColoredStatus, (value) => patchSettings({ gitColoredStatus: value })],
                ['隐藏 Git 候选项', settings.hideGitCandidates, (value) => patchSettings({ hideGitCandidates: value })],
              ]}
            />
          </SettingsSection>
          <SettingsSection title="系统通知" desc="当窗口未聚焦时，为关键对话事件发送系统通知">
            <SwitchList
              items={[
                ['启用后台系统通知', settings.notifyBackground, (value) => patchSettings({ notifyBackground: value })],
                ['对话完成时通知', settings.notifyCompletion, (value) => patchSettings({ notifyCompletion: value })],
                ['需要输入时通知', settings.notifyInputRequired, (value) => patchSettings({ notifyInputRequired: value })],
                ['对话出错时通知', settings.notifyError, (value) => patchSettings({ notifyError: value })],
                ['需要确认时通知', settings.notifyConfirmation, (value) => patchSettings({ notifyConfirmation: value })],
              ]}
            />
          </SettingsSection>
          <SettingsSection title="字体显示" desc="设置界面、正文、代码和终端字体，并立即预览实际排版。">
            <FontDisplayPanel
              settings={settings}
              patchSettings={patchSettings}
            />
          </SettingsSection>
        </SettingsStack>
      )
    case '快捷键':
      return (
        <SettingsStack>
          <SettingsSection title="快捷键" desc="配置常用操作的键盘组合。">
            <ShortcutSettingsPanel settings={settings} patchSettings={patchSettings} />
          </SettingsSection>
        </SettingsStack>
      )
    case '工具权限':
      return (
        <SettingsStack>
          <SettingsSection title="工具权限" desc="设置工具整体执行方式。Auto 会直接按系统策略执行；Ask 会按下方每个工具的规则决定是否确认。">
            <InsetPanel>
              <ShortcutRow
                title="工具执行模式"
                desc={settings.toolPermissionMode === 'Auto' ? '当前所有工具按自动执行处理；切换到 Ask 后会启用下方逐项规则。' : '当前会读取下方逐项规则；标为 Ask 的工具在执行前需要确认。'}
              >
                <SegmentedControl value={settings.toolPermissionMode} options={['Auto', 'Ask']} onChange={(toolPermissionMode) => patchSettings({ toolPermissionMode })} />
              </ShortcutRow>
            </InsetPanel>
            <ToolPermissionTable
              mode={settings.toolPermissionMode}
              permissions={settings.toolPermissions}
              onChange={(name, value) => patchSettings({ toolPermissions: { ...settings.toolPermissions, [name]: value } })}
            />
          </SettingsSection>
        </SettingsStack>
      )
    case '归档会话':
      return (
        <SettingsStack>
          <SettingsSection title="归档会话" desc="查看已归档的会话记录。归档后不会出现在会话列表中，但仍可在这里打开查看内容。">
            <ArchivedSessionsPanel retention={settings.archivedRetention} onRetentionChange={(archivedRetention) => patchSettings({ archivedRetention })} />
          </SettingsSection>
        </SettingsStack>
      )
    case '控制台':
      return (
        <SettingsStack>
          <ConsolePanel debugEnabled={settings.debugMode} />
        </SettingsStack>
      )
    case '关于':
      return (
        <SettingsStack>
          <SettingsSection title="关于" desc="查看当前产品信息与联系方式。">
            <div className="max-w-[720px] rounded-xl border border-neutral-200 bg-white p-5">
              <div className="mb-5 border-b border-neutral-200 pb-5">
                <div className="h-5 w-24 rounded bg-neutral-200" />
                <div className="mt-3 h-4 w-40 rounded bg-neutral-100" />
              </div>
              <div className="grid max-w-md grid-cols-[6rem_1fr] gap-y-4 text-sm">
                <span className="text-neutral-500">{t('应用')}</span><span className="font-medium">AgentHub</span>
                <span className="text-neutral-500">{t('版本')}</span><span className="font-medium">0.1.0</span>
                <span className="text-neutral-500">{t('开发组织')}</span><span className="font-medium">AgentHub</span>
                <span className="text-neutral-500">{t('联系邮箱')}</span><span className="font-medium">771473941@qq.com</span>
                <span className="text-neutral-500">{t('版本来源')}</span><span className="font-medium">{t('本地开发版')}</span>
                <span className="text-neutral-500">{t('上次检查')}</span><span><button type="button" disabled className="settings-soft-button opacity-50">{t('检查更新')}</button></span>
              </div>
            </div>
          </SettingsSection>
        </SettingsStack>
      )
    default:
      return null
  }
}

function MobilePairingPanel() {
  const { t } = useI18n()
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function createPairingCode() {
    if (loading) return
    setLoading(true)
    setMessage('')
    try {
      const result = await api.startMobilePairing()
      const dataUrl = await QRCode.toDataURL(result.qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 7,
        color: {
          dark: '#171717',
          light: '#ffffff',
        },
      })
      setQrDataUrl(dataUrl)
      setBaseUrl(result.baseUrl)
      setWebUrl(result.webUrl)
      setExpiresAt(result.expiresAt)
      setPairingCode(result.pairingCode)
      setMessage(t('请用 Android 客户端点击“扫码连接”扫描二维码'))
    } catch (error: any) {
      setMessage(error?.message || t('生成二维码失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <InsetPanel>
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="grid min-h-64 place-items-center rounded-xl border border-neutral-200 bg-white p-4">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={t('移动端配对二维码')} className="h-52 w-52 rounded-lg" />
          ) : (
            <div className="grid h-52 w-52 place-items-center rounded-xl border border-dashed border-neutral-200 bg-neutral-50 text-neutral-400">
              <QrCode className="h-10 w-10" />
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
              <Smartphone className="h-4 w-4" />
              {t('局域网移动端配对')}
            </div>
            <button type="button" className="settings-soft-button" disabled={loading} onClick={() => void createPairingCode()}>
              {loading ? t('生成中') : qrDataUrl ? t('刷新二维码') : t('生成二维码')}
            </button>
          </div>
          <InfoRow label="Server" value={baseUrl || t('等待生成')} />
          <InfoRow label="Web" value={webUrl || t('等待生成')} />
          <InfoRow label="配对码" value={pairingCode || t('等待生成')} />
          <InfoRow label="过期时间" value={expiresAt ? new Date(expiresAt).toLocaleString() : t('等待生成')} />
          {message && <Notice tone={qrDataUrl ? 'neutral' : 'warning'}>{message}</Notice>}
          <Notice>
            {t('手机和电脑需要在同一 Wi-Fi 或局域网内。若扫码后无法连接，请确认 Windows 防火墙已放行服务端端口 8000。')}
          </Notice>
        </div>
      </div>
    </InsetPanel>
  )
}

const shortcutActionLabels: Record<ShortcutActionId, { title: string; desc: string }> = {
  'new-chat': { title: '新建会话', desc: '在会话页打开新建会话弹窗。' },
  'quick-chat': { title: '快速对话', desc: '立即创建一个空白直接对话。' },
  'open-folder': { title: '打开项目文件夹', desc: '选择本地项目文件夹并进入群聊。' },
  settings: { title: '打开设置', desc: '从任意页面进入设置中心。' },
  'new-window': { title: '新建窗口', desc: '桌面端打开一个新的 AgentHub 窗口。' },
  'close-window': { title: '关闭窗口', desc: '关闭当前桌面窗口。' },
  reload: { title: '重新加载', desc: '刷新当前 AgentHub 页面。' },
  minimize: { title: '最小化', desc: '最小化当前桌面窗口。' },
  'toggle-maximize': { title: '最大化 / 还原', desc: '切换当前桌面窗口的最大化状态。' },
  'toggle-fullscreen': { title: '切换全屏', desc: '进入或退出全屏模式。' },
}

function ShortcutSettingsPanel({
  settings,
  patchSettings,
}: {
  settings: AppSettings
  patchSettings: (patch: Partial<AppSettings>) => void
}) {
  const { t } = useI18n()
  const [recording, setRecording] = useState<ShortcutActionId | null>(null)
  const [notice, setNotice] = useState('')
  const bindings = normalizeShortcutBindings(settings.shortcuts)

  useEffect(() => {
    if (!recording) return

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()
      const next = shortcutFromRecordingEvent(event)
      if (next === 'Escape') {
        setRecording(null)
        setNotice(t('已取消录制'))
        return
      }
      if (!next) {
        setNotice(t('请按包含 Ctrl、Alt、Shift、Cmd 或功能键的组合'))
        return
      }

      const activeRecording = recording
      if (!activeRecording) return
      const conflict = shortcutConflict(bindings, activeRecording, next)
      const nextBindings = bindings.map((item) => {
        if (item.action === activeRecording) return { ...item, keys: next }
        if (conflict && item.action === conflict.action) return { ...item, keys: '' }
        return item
      })
      patchSettings({ shortcuts: nextBindings })
      setNotice(conflict ? `${t('已替换冲突快捷键')}：${t(shortcutActionLabels[conflict.action].title)}` : t('快捷键已更新'))
      setRecording(null)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [bindings, patchSettings, recording, t])

  function restoreShortcut(action: ShortcutActionId) {
    const defaults = new Map(defaultShortcutBindings.map((item) => [item.action, item.keys]))
    patchSettings({
      shortcuts: bindings.map((item) => (item.action === action ? { ...item, keys: defaults.get(action) ?? '' } : item)),
    })
    setNotice(t('已恢复默认快捷键'))
  }

  function restoreAllShortcuts() {
    patchSettings({ shortcuts: defaultShortcutBindings })
    setNotice(t('已恢复全部默认快捷键'))
  }

  function renderKeys(keys: string) {
    if (!keys) return <span className="text-xs text-neutral-400">{t('未设置')}</span>
    return keys.split('+').map((key) => <Keycap key={key}>{key}</Keycap>)
  }

  return (
    <>
      <InsetPanel>
        <ShortcutRow title="发送方式" desc="设置会话输入框里 Enter 与 Ctrl+Enter 的发送和换行行为。">
          <SelectPill value={settings.sendMode} options={['Enter 发送', 'Ctrl+Enter 发送']} onChange={(sendMode) => patchSettings({ sendMode })} />
        </ShortcutRow>
        {bindings.map((binding) => {
          const copy = shortcutActionLabels[binding.action]
          return (
            <ShortcutRow key={binding.action} title={copy.title} desc={copy.desc}>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="flex min-w-[9rem] justify-end gap-1.5">{renderKeys(binding.keys)}</div>
                <button
                  type="button"
                  className={cn('settings-soft-button', recording === binding.action && 'settings-shortcut-recording')}
                  onClick={() => {
                    setRecording(binding.action)
                    setNotice(t('请按下新的快捷键组合，按 Esc 取消'))
                  }}
                >
                  {recording === binding.action ? t('录制中') : t('录制')}
                </button>
                <button type="button" className="settings-soft-button" onClick={() => restoreShortcut(binding.action)}>
                  {t('恢复默认')}
                </button>
              </div>
            </ShortcutRow>
          )
        })}
      </InsetPanel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">{t('点击“录制”后按下组合键。至少包含 Ctrl、Alt、Shift 或 Cmd，按 Esc 取消。')}</p>
        <button type="button" className="settings-soft-button" onClick={restoreAllShortcuts}>
          {t('恢复全部默认')}
        </button>
      </div>
      {notice && <p className="text-xs" style={{ color: 'var(--settings-accent)' }}>{notice}</p>}
    </>
  )
}

function ArchivedSessionsPanel({
  retention,
  onRetentionChange,
}: {
  retention: string
  onRetentionChange: (value: string) => void
}) {
  const navigate = useNavigate()
  const { t, language } = useI18n()
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedIds, setArchivedIds] = useState<string[]>(() => loadSessionListPrefs().archived)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const archivedIdSet = new Set(archivedIds)
  const archivedSessions = sessions.filter((session) => archivedIdSet.has(session.id))
  const filteredSessions = archivedSessions.filter((session) => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return true
    return [session.title, session.type, session.workspaceId ?? '', session.workspaceAgentId ?? ''].join(' ').toLowerCase().includes(keyword)
  })
  const selectedSession = filteredSessions.find((session) => session.id === selectedId) ?? archivedSessions.find((session) => session.id === selectedId) ?? filteredSessions[0] ?? null
  const staleSessions = archivedSessions.filter((session) => isPastRetention(session.updatedAt, retention))

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const sync = () => setArchivedIds(loadSessionListPrefs().archived)
    window.addEventListener('storage', sync)
    window.addEventListener(sessionArchiveChangeEvent, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(sessionArchiveChangeEvent, sync)
    }
  }, [])

  useEffect(() => {
    if (!selectedSession) {
      setSelectedId(null)
      setMessages([])
      return
    }
    if (selectedId !== selectedSession.id) setSelectedId(selectedSession.id)
    let cancelled = false
    setLoadingMessages(true)
    api
      .listMessages(selectedSession.id)
      .then(({ items }) => {
        if (!cancelled) setMessages(items)
      })
      .catch(() => {
        if (!cancelled) setMessages([])
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSession?.id])

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2200)
  }

  async function refresh() {
    setLoading(true)
    try {
      const [{ items }, prefs] = await Promise.all([api.listSessions(), Promise.resolve(loadSessionListPrefs())])
      setSessions(items)
      const existingIds = new Set(items.map((session) => session.id))
      const nextArchived = prefs.archived.filter((id) => existingIds.has(id))
      if (nextArchived.length !== prefs.archived.length) {
        saveSessionListPrefs({ ...prefs, archived: nextArchived })
      }
      setArchivedIds(nextArchived)
      if (selectedId && !nextArchived.includes(selectedId)) setSelectedId(null)
    } finally {
      setLoading(false)
    }
  }

  function restoreSession(sessionId: string) {
    const prefs = loadSessionListPrefs()
    const nextArchived = prefs.archived.filter((id) => id !== sessionId)
    saveSessionListPrefs({ ...prefs, archived: nextArchived })
    setArchivedIds(nextArchived)
    if (selectedId === sessionId) setSelectedId(null)
    showNotice(t('会话已恢复到左侧列表'))
  }

  function restoreAll() {
    const prefs = loadSessionListPrefs()
    saveSessionListPrefs({ ...prefs, archived: [] })
    setArchivedIds([])
    setSelectedId(null)
    showNotice(t('所有归档会话已恢复'))
  }

  async function deleteSession(session: Session) {
    setBusyAction(`delete:${session.id}`)
    try {
      await api.deleteSession(session.id)
      const prefs = loadSessionListPrefs()
      const nextArchived = prefs.archived.filter((id) => id !== session.id)
      saveSessionListPrefs({ ...prefs, archived: nextArchived, pinned: prefs.pinned.filter((id) => id !== session.id) })
      setSessions((items) => items.filter((item) => item.id !== session.id))
      setArchivedIds(nextArchived)
      if (selectedId === session.id) setSelectedId(null)
      setDeleteTarget(null)
      showNotice(t('会话已删除'))
    } finally {
      setBusyAction(null)
    }
  }

  async function cleanupExpired() {
    if (!staleSessions.length) {
      showNotice(t('没有超过保留期的归档会话'))
      return
    }
    setBusyAction('cleanup')
    try {
      for (const session of staleSessions) {
        await api.deleteSession(session.id)
      }
      const removed = new Set(staleSessions.map((session) => session.id))
      const prefs = loadSessionListPrefs()
      const nextArchived = prefs.archived.filter((id) => !removed.has(id))
      saveSessionListPrefs({ ...prefs, archived: nextArchived, pinned: prefs.pinned.filter((id) => !removed.has(id)) })
      setSessions((items) => items.filter((session) => !removed.has(session.id)))
      setArchivedIds(nextArchived)
      if (selectedId && removed.has(selectedId)) setSelectedId(null)
      showNotice(t('已清理超过保留期的会话'))
    } finally {
      setBusyAction(null)
    }
  }

  function openSession(sessionId: string) {
    navigate(`/chat/${sessionId}`)
  }

  return (
    <div className="overflow-hidden rounded-2xl border shadow-sm" style={{ background: 'var(--settings-panel)', borderColor: 'var(--settings-border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--settings-border)', background: 'var(--settings-panel-muted)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <Archive className="h-4 w-4" style={{ color: 'var(--settings-accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t('归档会话')}</span>
          <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: 'var(--settings-accent-soft)', color: 'var(--settings-accent)' }}>
            {archivedSessions.length}
          </span>
          <span className="text-xs" style={{ color: 'var(--settings-muted-text)' }}>
            {staleSessions.length ? t('有会话超过保留期') : t('保留状态正常')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={retention}
            onChange={(event) => onRetentionChange(event.target.value)}
            className="h-8 rounded-lg border px-2 text-xs outline-none"
            style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)', color: 'var(--settings-text)' }}
          >
            {['30 天', '90 天', '180 天', '永久保留'].map((option) => <option key={option} value={option}>{t(option)}</option>)}
          </select>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="settings-soft-button h-8">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('刷新')}
          </button>
          <button type="button" onClick={restoreAll} disabled={!archivedSessions.length} className="settings-soft-button h-8">
            <ArchiveRestore className="h-3.5 w-3.5" />
            {t('恢复全部')}
          </button>
          <button type="button" onClick={() => void cleanupExpired()} disabled={!staleSessions.length || busyAction === 'cleanup'} className="settings-danger-button h-8 px-3">
            {busyAction === 'cleanup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t('清理过期')}
          </button>
        </div>
      </div>

      {notice && (
        <div className="border-b px-4 py-2 text-sm" style={{ borderColor: 'var(--settings-border)', color: 'var(--settings-accent)', background: 'var(--settings-accent-soft)' }}>
          {notice}
        </div>
      )}

      <div className="grid min-h-[680px] grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-r" style={{ borderColor: 'var(--settings-border)', background: 'var(--settings-sidebar)' }}>
          <div className="border-b p-3" style={{ borderColor: 'var(--settings-border)' }}>
            <div className="flex h-9 items-center gap-2 rounded-xl border px-3" style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)' }}>
              <Search className="h-4 w-4" style={{ color: 'var(--settings-muted-text)' }} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('搜索归档会话')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                style={{ color: 'var(--settings-text)' }}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="grid h-full place-items-center text-sm" style={{ color: 'var(--settings-muted-text)' }}>
                <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                {t('正在读取归档')}
              </div>
            ) : filteredSessions.length ? (
              <div className="space-y-1">
                {filteredSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedId(session.id)}
                    className="w-full rounded-xl border px-3 py-2.5 text-left transition hover:-translate-y-px"
                    style={{
                      background: selectedSession?.id === session.id ? 'var(--settings-active-bg)' : 'transparent',
                      borderColor: selectedSession?.id === session.id ? 'var(--settings-active-border)' : 'transparent',
                      color: 'var(--settings-text)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{session.title || t('未命名会话')}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: 'var(--settings-muted-text)' }}>{sessionTypeLabel(session)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: 'var(--settings-muted-text)' }}>
                      <Clock3 className="h-3.5 w-3.5" />
                      {relativeTime(session.updatedAt, language)}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid h-full place-items-center px-6 text-center">
                <div>
                  <Archive className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--settings-muted)' }} />
                  <div className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t('暂无归档会话')}</div>
                  <div className="mt-2 text-xs leading-5" style={{ color: 'var(--settings-muted-text)' }}>
                    {query.trim() ? t('没有匹配的归档会话') : t('归档后的会话会显示在这里。')}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          {selectedSession ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--settings-border)' }}>
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold" style={{ color: 'var(--settings-text)' }}>{selectedSession.title || t('未命名会话')}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--settings-muted-text)' }}>
                    <span>{sessionTypeLabel(selectedSession)}</span>
                    <span>·</span>
                    <span>{t('更新于')} {formatArchiveDate(selectedSession.updatedAt)}</span>
                    {isPastRetention(selectedSession.updatedAt, retention) && <span style={{ color: '#dc2626' }}>{t('超过保留期')}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => openSession(selectedSession.id)} className="settings-soft-button">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('打开会话')}
                  </button>
                  <button type="button" onClick={() => restoreSession(selectedSession.id)} className="settings-soft-button">
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    {t('恢复')}
                  </button>
                  <button type="button" onClick={() => setDeleteTarget(selectedSession)} className="settings-danger-button">
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('删除')}
                  </button>
                </div>
              </div>

              <div className="grid gap-3 border-b p-4 sm:grid-cols-3" style={{ borderColor: 'var(--settings-border)' }}>
                <ArchiveMetric icon={<MessageSquare className="h-4 w-4" />} label="消息数量" value={loadingMessages ? t('读取中') : String(messages.length)} />
                <ArchiveMetric icon={<Clock3 className="h-4 w-4" />} label="最后更新" value={relativeTime(selectedSession.updatedAt, language)} />
                <ArchiveMetric icon={<FileText className="h-4 w-4" />} label="保留策略" value={retention} />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {loadingMessages ? (
                  <div className="grid h-full place-items-center text-sm" style={{ color: 'var(--settings-muted-text)' }}>
                    <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                    {t('正在读取会话内容')}
                  </div>
                ) : messages.length ? (
                  <div className="space-y-3">
                    {messages.map((message) => (
                      <ArchivedMessageBubble key={message.id} message={message} />
                    ))}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center text-center text-sm" style={{ color: 'var(--settings-muted-text)' }}>
                    {t('这个归档会话还没有消息。')}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center px-8 text-center">
              <div>
                <MessageSquare className="mx-auto mb-3 h-9 w-9" style={{ color: 'var(--settings-muted)' }} />
                <div className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t('选择一个归档会话')}</div>
                <div className="mt-2 max-w-sm text-sm leading-6" style={{ color: 'var(--settings-muted-text)' }}>
                  {t('选择左侧会话后，在这里查看归档内容。')}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/30 px-4 backdrop-blur-md" role="dialog" aria-modal="true" onMouseDown={() => setDeleteTarget(null)}>
          <div className="w-full max-w-[382px] rounded-2xl border p-4 shadow-[0_24px_80px_rgba(15,23,42,0.16)]" style={{ background: 'var(--settings-panel)', borderColor: 'var(--settings-border)' }} onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-500">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t('删除归档会话')}</div>
                <p className="mt-1 text-xs leading-5" style={{ color: 'var(--settings-muted-text)' }}>
                  {t('这个会话和其中的消息会被永久删除，无法恢复。')}
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-xl border px-3 py-2" style={{ background: 'var(--settings-panel-muted)', borderColor: 'var(--settings-border)' }}>
              <div className="truncate text-sm font-medium" style={{ color: 'var(--settings-text)' }}>{deleteTarget.title || t('未命名会话')}</div>
              <div className="mt-0.5 text-xs" style={{ color: 'var(--settings-muted-text)' }}>{relativeTime(deleteTarget.updatedAt, language)}</div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={Boolean(busyAction)} className="settings-soft-button h-10">
                {t('取消')}
              </button>
              <button type="button" onClick={() => void deleteSession(deleteTarget)} disabled={Boolean(busyAction)} className="settings-danger-button h-10">
                {busyAction === `delete:${deleteTarget.id}` && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('删除')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ArchiveMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  const { t } = useI18n()
  return (
    <div className="rounded-xl border px-3 py-3" style={{ background: 'var(--settings-panel-muted)', borderColor: 'var(--settings-border)' }}>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--settings-muted-text)' }}>
        {icon}
        {t(label)}
      </div>
      <div className="mt-1 truncate text-sm font-semibold" style={{ color: 'var(--settings-text)' }} title={value}>{value}</div>
    </div>
  )
}

function ArchivedMessageBubble({ message }: { message: Message }) {
  const sender = archivedSenderLabel(message)
  const displayContent = typeof message.metadata?.displayContent === 'string' ? message.metadata.displayContent : message.content
  return (
    <div className={cn('max-w-[84%] rounded-2xl border px-4 py-3', message.senderType === 'user' && 'ml-auto')} style={{
      background: message.senderType === 'user' ? 'var(--settings-active-bg)' : 'var(--settings-control-bg)',
      borderColor: message.senderType === 'user' ? 'var(--settings-active-border)' : 'var(--settings-border)',
    }}>
      <div className="mb-1 flex items-center justify-between gap-3 text-xs" style={{ color: 'var(--settings-muted-text)' }}>
        <span className="font-medium">{sender}</span>
        <span>{formatArchiveDate(message.createdAt)}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm leading-6" style={{ color: 'var(--settings-text)' }}>
        {displayContent || ' '}
      </div>
    </div>
  )
}

function archivedSenderLabel(message: Message) {
  if (message.senderType === 'user') return 'User'
  if (message.senderType === 'system') return 'System'
  return message.senderId || 'Agent'
}

function sessionTypeLabel(session: Session) {
  if (session.type === 'group') return '群聊'
  if (session.workspaceAgentId) return 'Agent 子会话'
  return '普通会话'
}

function formatArchiveDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function isPastRetention(updatedAt: string, retention: string) {
  const days = retentionDays(retention)
  if (!days) return false
  const updated = new Date(updatedAt).getTime()
  if (Number.isNaN(updated)) return false
  return Date.now() - updated > days * 24 * 60 * 60 * 1000
}

function retentionDays(retention: string) {
  if (retention.includes('30')) return 30
  if (retention.includes('90')) return 90
  if (retention.includes('180')) return 180
  return null
}

function AutoSaveStatus({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const { t } = useI18n()
  const label =
    state === 'saving'
      ? '自动保存中'
      : state === 'saved'
        ? '已自动保存'
        : state === 'error'
          ? '自动保存失败'
          : '自动保存已开启'

  return (
    <div
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium',
        state === 'error'
          ? 'border-red-200 bg-red-50 text-red-600'
          : state === 'saved'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-neutral-200 bg-white text-neutral-500'
      )}
    >
      {state === 'saving' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === 'saved' ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <span className={cn('h-2 w-2 rounded-full', state === 'error' ? 'bg-red-500' : 'bg-neutral-300')} />
      )}
      {t(label)}
    </div>
  )
}

function SettingsStack({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[1180px] space-y-9 pb-10">{children}</div>
}

function SettingsSection({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t(title)}</h2>
        {desc && <p className="mt-2 text-sm leading-6" style={{ color: 'var(--settings-muted-text)' }}>{t(desc)}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function InsetPanel({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 rounded-xl border p-4 shadow-sm" style={{ background: 'var(--settings-panel)', borderColor: 'var(--settings-border)' }}>{children}</div>
}

function AccountAvatarPreview({
  name,
  avatar,
  size = 'small',
}: {
  name: string
  avatar: string
  size?: 'small' | 'large'
}) {
  const dimension = size === 'large' ? 'h-16 w-16 text-2xl' : 'h-10 w-10 text-sm'
  const fallback = (name.trim().slice(0, 1) || 'Y').toUpperCase()
  return (
    <div className={cn('grid shrink-0 place-items-center overflow-hidden rounded-2xl border bg-white shadow-sm', dimension)} style={{ borderColor: 'var(--settings-border)' }}>
      {avatar ? (
        <img src={avatar} alt={name || 'Account avatar'} className="h-full w-full object-cover" />
      ) : (
        <span className="font-semibold" style={{ color: 'var(--settings-accent)' }}>{fallback}</span>
      )}
    </div>
  )
}

function StorageMetric({ label, value }: { label: string; value: string }) {
  const { t } = useI18n()
  return (
    <div className="rounded-xl border px-3 py-3" style={{ background: 'var(--settings-panel-muted)', borderColor: 'var(--settings-border)' }}>
      <div className="text-xs font-medium" style={{ color: 'var(--settings-muted-text)' }}>{t(label)}</div>
      <div className="mt-1 truncate text-lg font-semibold" style={{ color: 'var(--settings-text)' }} title={value}>{value}</div>
    </div>
  )
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-xs font-medium',
        ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-neutral-200 bg-neutral-50 text-neutral-500'
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-neutral-400')} />
      {t(label)}
    </span>
  )
}

function Notice({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm leading-6',
        tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-neutral-200 bg-neutral-50 text-neutral-600'
      )}
    >
      {children}
    </div>
  )
}

function InlineSwitch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3">
      <SmallToggle checked={checked} onChange={onChange} />
      <span className="text-sm font-medium" style={{ color: 'var(--settings-text)' }}>{t(label)}</span>
    </div>
  )
}

function SegmentedControl({ value, options, onChange, disabled = false }: { value: string; options: string[]; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <div className={cn('inline-flex overflow-hidden rounded-lg border p-0.5', disabled && 'opacity-60')} style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)' }}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option)}
          className={cn(
            'h-7 min-w-14 rounded-md px-3 text-sm transition hover:brightness-95 disabled:cursor-not-allowed'
          )}
          style={{
            background: value === option ? 'var(--settings-accent-soft)' : 'transparent',
            color: value === option ? 'var(--settings-accent)' : 'var(--settings-muted-text)',
          }}
        >
          {t(option)}
        </button>
      ))}
    </div>
  )
}

function SwitchList({ items }: { items: Array<[string, boolean, (value: boolean) => void]> }) {
  return (
    <div className="space-y-4">
      {items.map(([label, checked, onChange]) => (
        <InlineSwitch key={label} checked={checked} onChange={onChange} label={label} />
      ))}
    </div>
  )
}

function ThemeDisplayPanel({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useI18n()
  const mainTheme = resolveTheme(settings.mainWindowTheme)
  const accent = accentColor(settings.accent)

  return (
    <InsetPanel>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <div>
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t('主窗口')}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              {themeModes.map((mode) => (
                <ThemeOption
                  key={`main-${mode}`}
                  mode={mode}
                  active={settings.mainWindowTheme === mode}
                  accent={accent}
                  onClick={() => patchSettings({ mainWindowTheme: mode, theme: mode === '跟随系统' ? settings.theme : mode })}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t('强调色')}</div>
            <div className="flex flex-wrap gap-2">
              {accentOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => patchSettings({ accent: option })}
                  className="flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition hover:-translate-y-px"
                  style={{
                    background: settings.accent === option ? accent : 'var(--settings-control-bg)',
                    borderColor: settings.accent === option ? accent : 'var(--settings-border)',
                    color: settings.accent === option ? '#ffffff' : 'var(--settings-text)',
                  }}
                >
                  <span className="h-3.5 w-3.5 rounded-full" style={{ background: accentColor(option) }} />
                  {t(option)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <ThemePreview mainTheme={mainTheme} accent={accent} />
      </div>
    </InsetPanel>
  )
}

function ThemeOption({ mode, active, accent, onClick }: { mode: string; active: boolean; accent: string; onClick: () => void }) {
  const { t } = useI18n()
  const palette = themePalette(resolveTheme(mode))
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm"
      style={{
        background: active ? 'var(--settings-active-bg)' : 'var(--settings-control-bg)',
        borderColor: active ? accent : 'var(--settings-border)',
        boxShadow: active ? `0 0 0 1px ${accent}22, 0 10px 24px rgba(15, 23, 42, 0.08)` : undefined,
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t(mode)}</span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: active ? accent : 'var(--settings-muted)' }} />
      </div>
      <div className="overflow-hidden rounded-lg border" style={{ background: palette.bg, borderColor: palette.border }}>
        <div className="h-5" style={{ background: palette.chrome }} />
        <div className="space-y-1.5 p-2">
          <div className="h-2 w-2/3 rounded-full" style={{ background: palette.muted }} />
          <div className="h-5 rounded-md" style={{ background: palette.panel }} />
          <div className="h-1.5 w-10 rounded-full" style={{ background: accent }} />
        </div>
      </div>
    </button>
  )
}

function ThemePreview({ mainTheme, accent }: { mainTheme: 'light' | 'dark'; accent: string }) {
  const { t } = useI18n()
  const main = themePalette(mainTheme)
  return (
    <div className="rounded-2xl border p-3" style={{ background: 'var(--settings-panel-muted)', borderColor: 'var(--settings-border)' }}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--settings-muted-text)' }}>{t('显示预览')}</span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
      </div>
      <div className="overflow-hidden rounded-xl border shadow-sm" style={{ background: main.bg, borderColor: main.border }}>
        <div className="flex h-8 items-center gap-1.5 px-3" style={{ background: main.chrome }}>
          <span className="h-2 w-2 rounded-full bg-red-300" />
          <span className="h-2 w-2 rounded-full bg-amber-300" />
          <span className="h-2 w-2 rounded-full bg-emerald-300" />
        </div>
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg" style={{ background: accent }} />
            <div>
              <div className="h-2.5 w-24 rounded-full" style={{ background: main.text }} />
              <div className="mt-1.5 h-2 w-16 rounded-full" style={{ background: main.muted }} />
            </div>
          </div>
          <div className="rounded-lg p-3" style={{ background: main.panel }}>
            <div className="h-2 w-4/5 rounded-full" style={{ background: main.text }} />
            <div className="mt-2 h-2 w-2/3 rounded-full" style={{ background: main.muted }} />
          </div>
        </div>
      </div>
    </div>
  )
}

function FontDisplayPanel({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useI18n()
  return (
    <InsetPanel>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <FontSelect label="界面" value={settings.uiFont} onChange={(uiFont) => patchSettings({ uiFont })} />
            <FontSelect label="正文" value={settings.bodyFont} onChange={(bodyFont) => patchSettings({ bodyFont })} />
            <FontSelect label="行内代码" value={settings.inlineCodeFont} onChange={(inlineCodeFont) => patchSettings({ inlineCodeFont })} />
            <FontSelect label="代码块" value={settings.codeBlockFont} onChange={(codeBlockFont) => patchSettings({ codeBlockFont })} />
            <FontSelect label="编辑器 / 终端" value={settings.terminalFont} onChange={(terminalFont) => patchSettings({ terminalFont })} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t('字体大小')}</div>
              <SegmentedControl value={settings.fontSize} options={fontSizeOptions} onChange={(fontSize) => patchSettings({ fontSize })} />
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t('消息样式')}</div>
              <SegmentedControl value={settings.bubbleStyle} options={messageStyleOptions} onChange={(bubbleStyle) => patchSettings({ bubbleStyle })} />
            </div>
          </div>

          <button
            type="button"
            className="settings-soft-button"
            onClick={() =>
              patchSettings({
                bodyFont: '默认',
                codeBlockFont: '默认',
                fontSize: '14',
                inlineCodeFont: '默认',
                terminalFont: '默认',
                uiFont: '默认',
              })
            }
          >
            {t('恢复默认字体')}
          </button>
        </div>

        <FontPreview settings={settings} />
      </div>
    </InsetPanel>
  )
}

function FontSelect({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-neutral-500">{t(label)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-lg border px-3 text-sm font-medium outline-none transition focus:brightness-95" style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)', color: 'var(--settings-text)' }}>
        {fontOptions.map((option) => <option key={option} value={option}>{t(option)}</option>)}
      </select>
    </label>
  )
}

function FontPreview({ settings }: { settings: AppSettings }) {
  const { t } = useI18n()
  const uiFont = fontStack(settings.uiFont, 'ui')
  const bodyFont = fontStack(settings.bodyFont, 'body')
  const codeFont = fontStack(settings.codeBlockFont, 'mono')
  const size = `${settings.fontSize}px`
  return (
    <div className="rounded-2xl border p-4" style={{ background: 'var(--settings-panel-muted)', borderColor: 'var(--settings-border)' }}>
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--settings-muted-text)' }}>{t('字体预览')}</div>
      <div className="rounded-xl border p-4" style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)' }}>
        <div style={{ fontFamily: uiFont, color: 'var(--settings-text)' }} className="text-sm font-semibold">{t('AgentHub 显示效果')}</div>
        <p style={{ fontFamily: bodyFont, fontSize: size, color: 'var(--settings-muted-text)' }} className="mt-3 leading-7">
          {t('这是一段聊天正文预览，用于检查字号、字重和中英文混排。')}
        </p>
        <div style={{ fontFamily: codeFont }} className="mt-3 rounded-lg bg-neutral-950 px-3 py-2 text-[13px] leading-6 text-neutral-100">
          <div>const agent = "AgentHub"</div>
          <div>run(agent, workspace)</div>
        </div>
        <div className={cn('mt-3 max-w-[85%] rounded-xl px-3 py-2 text-sm text-white', settings.bubbleStyle === '紧凑' ? 'rounded-md py-1.5' : settings.bubbleStyle === '气泡' ? 'rounded-2xl' : '')} style={{ background: accentColor(settings.accent), fontFamily: bodyFont }}>
          {t('消息气泡预览')}
        </div>
      </div>
    </div>
  )
}

function RuntimeRow({ label, value, action, busy, onAction }: { label: string; value: string; action?: string; busy?: boolean; onAction?: () => void }) {
  const { t } = useI18n()
  return (
    <div className={cn('grid items-center gap-3', onAction ? 'grid-cols-[5rem_minmax(0,1fr)_auto]' : 'grid-cols-[5rem_minmax(0,1fr)]')}>
      <span className="text-sm text-slate-600">{t(label)}</span>
      <div className="truncate rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm font-medium text-slate-900">{value}</div>
      {onAction && action && <button type="button" disabled={busy} onClick={onAction} className="settings-soft-button">{busy ? t('刷新中') : t(action)}</button>}
    </div>
  )
}

function ShortcutRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-16 items-center justify-between gap-6 rounded-xl border px-4 py-3" style={{ borderColor: 'var(--settings-border)', background: 'var(--settings-control-bg)' }}>
      <div>
        <div className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t(title)}</div>
        <div className="mt-1 text-sm" style={{ color: 'var(--settings-muted-text)' }}>{t(desc)}</div>
      </div>
      {children}
    </div>
  )
}

function SelectPill({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-80 rounded-md border px-3 text-center text-sm font-medium outline-none" style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)', color: 'var(--settings-text)' }}>
      {options.map((option) => <option key={option} value={option}>{t(option)}</option>)}
    </select>
  )
}

function Keycap({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md border px-3 py-1 text-sm font-semibold shadow-sm" style={{ background: 'var(--settings-control-bg)', borderColor: 'var(--settings-border)', color: 'var(--settings-text)' }}>{children}</span>
}

const toolRows = [
  ['read', '读取文件', '只读'],
  ['grep', '搜索文件内容', '只读'],
  ['list', '列出目录内容', '只读'],
  ['task', '委托子 Agent', '协作'],
  ['todowrite', '管理待办事项', '协作'],
  ['ask_user_question', '向用户询问', '协作'],
  ['unity_yaml_search', '搜索 Unity YAML 层级', '只读'],
  ['unity_yaml_read', '读取 Unity YAML 详情', '只读'],
  ['knowledge_list', '列出知识文档', '知识库'],
  ['knowledge_query', '搜索知识文档', '知识库'],
  ['knowledge_read', '读取知识条目', '知识库'],
  ['knowledge_create', '创建知识条目', '写入'],
  ['knowledge_delete', '删除知识条目', '高风险'],
  ['knowledge_move', '移动知识条目', '写入'],
  ['knowledge_edit', '编辑知识条目', '高风险'],
] as const

function ToolPermissionTable({
  mode,
  permissions,
  onChange,
}: {
  mode: string
  permissions: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  const { t } = useI18n()
  const globalAuto = mode === 'Auto'
  const askCount = toolRows.filter(([name]) => (permissions[name] ?? defaultAppSettings.toolPermissions[name] ?? 'Auto') === 'Ask').length
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="grid grid-cols-[1fr_7rem_auto] border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-xs font-semibold text-slate-600">
        <span>{t('工具')}</span>
        <span>{t('类型')}</span>
        <span>{globalAuto ? t('全局自动执行') : `${askCount} ${t('项需要确认')}`}</span>
      </div>
      {toolRows.map(([name, desc, scope]) => {
        const savedValue = permissions[name] ?? defaultAppSettings.toolPermissions[name] ?? 'Auto'
        const effectiveValue = globalAuto ? 'Auto' : savedValue
        return (
        <div key={name} className={cn('grid grid-cols-[1fr_7rem_auto] items-center border-b border-neutral-200 px-4 py-3 last:border-b-0', globalAuto && 'opacity-75')}>
          <div>
            <div className="font-mono text-sm font-semibold text-neutral-950">{name}</div>
            <div className="mt-1 text-xs text-slate-600">{t(desc)}</div>
          </div>
          <span className="text-xs font-medium text-neutral-500">{t(scope)}</span>
          <div className="flex items-center justify-end gap-2">
            <span className="hidden text-xs text-neutral-400 xl:inline">
              {globalAuto ? t('继承全局') : effectiveValue === 'Ask' ? t('执行前确认') : t('自动执行')}
            </span>
            <SegmentedControl value={effectiveValue} options={['Auto', 'Ask']} disabled={globalAuto} onChange={(value) => onChange(name, value)} />
          </div>
        </div>
      )})}
    </div>
  )
}

type ConsoleLogLevel = 'Trace' | 'Debug' | 'Info' | 'Warn' | 'Error'
type ConsoleLogSource = '后端' | '前端' | 'Agent' | '桌面端'

interface ConsoleLogRow {
  id: string
  time: string
  level: ConsoleLogLevel
  source: ConsoleLogSource
  module: string
  content: string
}

const consoleLevelOptions = ['全部级别', 'Trace', 'Debug', 'Info', 'Warn', 'Error']
const consoleSourceOptions = ['全部来源', '后端', '前端', 'Agent', '桌面端']

function createConsoleSeedRows(): ConsoleLogRow[] {
  const now = new Date()
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60 * 1000).toLocaleTimeString('zh-CN', { hour12: false })
  return [
    { id: 'log-1', time: at(0), level: 'Info', source: '后端', module: 'settings', content: '控制台已连接本地服务，等待诊断输出' },
    { id: 'log-2', time: at(1), level: 'Debug', source: 'Agent', module: 'agent-runtime', content: 'code agent stream connected, waiting for output chunks' },
    { id: 'log-3', time: at(3), level: 'Info', source: '前端', module: 'settings', content: 'settings panel rendered and preferences persisted' },
    { id: 'log-4', time: at(5), level: 'Warn', source: '后端', module: 'workspace', content: 'dev server preview is not attached to a workspace session' },
    { id: 'log-5', time: at(8), level: 'Error', source: '后端', module: 'asset_db::watcher', content: 'worker 1 error processing workspace icons: No GUID in generated file metadata' },
    { id: 'log-6', time: at(10), level: 'Trace', source: '桌面端', module: 'sidecar', content: 'sidecar heartbeat received; service window is healthy' },
  ]
}

function ConsolePanel({ debugEnabled }: { debugEnabled: boolean }) {
  const { t } = useI18n()
  const [logs, setLogs] = useState<ConsoleLogRow[]>(() => createConsoleSeedRows())
  const [level, setLevel] = useState('全部级别')
  const [source, setSource] = useState('全部来源')
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [generalInfo, setGeneralInfo] = useState<SettingsGeneralInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const tableRef = useRef<HTMLDivElement | null>(null)
  const filteredLogs = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return logs.filter((row) => {
      if (level !== '全部级别' && row.level !== level) return false
      if (source !== '全部来源' && row.source !== source) return false
      if (!keyword) return true
      return [row.module, row.content, row.source, row.level].join(' ').toLowerCase().includes(keyword)
    })
  }, [level, logs, query, source])
  const errorCount = logs.filter((row) => row.level === 'Error').length
  const warningCount = logs.filter((row) => row.level === 'Warn').length
  const agentCount = logs.filter((row) => row.source === 'Agent').length
  const backendCount = logs.filter((row) => row.source === '后端').length

  useEffect(() => {
    void refreshDiagnostics(false)
  }, [])

  useEffect(() => {
    if (!autoScroll) return
    tableRef.current?.scrollTo({ top: tableRef.current.scrollHeight, behavior: 'smooth' })
  }, [autoScroll, filteredLogs.length])

  function appendLog(row: Omit<ConsoleLogRow, 'id' | 'time'>) {
    setLogs((current) => [
      ...current,
      {
        ...row,
        id: `log-${Date.now()}-${current.length}`,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      },
    ])
  }

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2200)
  }

  async function refreshDiagnostics(visible = true) {
    setBusy('refresh')
    try {
      const info = await api.getSettingsGeneralInfo()
      setGeneralInfo(info)
      appendLog({
        level: 'Info',
        source: '后端',
        module: 'settings/general-info',
        content: `诊断刷新完成：data=${info.storage.sizeLabel}, debug=${info.debug.sizeLabel}, git=${info.git.ok ? 'ok' : 'missing'}, python=${info.python.ok ? 'ok' : 'missing'}`,
      })
      if (visible) showNotice(t('诊断信息已刷新'))
    } catch (error: any) {
      appendLog({
        level: 'Error',
        source: '前端',
        module: 'settings/general-info',
        content: error?.message || '刷新诊断信息失败',
      })
      if (visible) showNotice(error?.message || t('操作失败'))
    } finally {
      setBusy(null)
    }
  }

  async function openPathWithFallback(path: string | undefined, label: string) {
    if (!path) {
      showNotice(t('路径尚未就绪'))
      return
    }
    setBusy(label)
    try {
      const opened = await openPath(path)
      if (!opened) await api.openLocalPath(path)
      appendLog({ level: 'Info', source: '桌面端', module: 'open-path', content: `${label}: ${path}` })
      showNotice(t('已打开目录'))
    } catch (error: any) {
      appendLog({ level: 'Error', source: '桌面端', module: 'open-path', content: error?.message || '打开目录失败' })
      showNotice(error?.message || t('操作失败'))
    } finally {
      setBusy(null)
    }
  }

  async function copyLogs() {
    const text = formatConsoleLogs(filteredLogs)
    try {
      await navigator.clipboard.writeText(text)
      showNotice(t('已复制日志'))
    } catch {
      showNotice(t('复制失败'))
    }
  }

  function exportLogs() {
    const blob = new Blob([formatConsoleLogs(filteredLogs)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `agenthub-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`
    link.click()
    URL.revokeObjectURL(url)
    showNotice(t('已导出日志'))
  }

  function clearLogs() {
    setLogs([])
    showNotice(t('日志已清空'))
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-xl border px-3 py-2 text-sm shadow-sm" style={{ background: 'var(--settings-accent-soft)', borderColor: 'var(--settings-active-border)', color: 'var(--settings-accent)' }}>
          {notice}
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-4">
        <ConsoleMetric icon={Server} label="后端日志" value={backendCount} detail={generalInfo?.storage.logDir ?? '等待刷新'} ok />
        <ConsoleMetric icon={Activity} label="Agent 事件" value={agentCount} detail="流式输出、命令和文件变更会进入这里" ok />
        <ConsoleMetric icon={AlertTriangle} label="警告 / 错误" value={warningCount + errorCount} detail={errorCount ? `${errorCount} 个错误需要处理` : '暂无阻塞错误'} ok={errorCount === 0} />
        <ConsoleMetric icon={Database} label="数据与调试" value={generalInfo?.debug.sizeLabel ?? '0 B'} detail={debugEnabled ? '调试模式已开启' : '调试模式已关闭'} ok={debugEnabled} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="rounded-2xl border p-4 shadow-sm" style={{ background: 'var(--settings-panel)', borderColor: 'var(--settings-border)' }}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SegmentedControl value={level} options={consoleLevelOptions} onChange={setLevel} />
            <SegmentedControl value={source} options={consoleSourceOptions} onChange={setSource} />
            <InlineSwitch checked={autoScroll} onChange={setAutoScroll} label="自动滚动" />
            <div className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--settings-muted-text)' }} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="settings-input h-9 pl-9"
                placeholder={t('按模块名或日志内容筛选')}
              />
            </div>
            <button type="button" disabled={busy === 'refresh'} onClick={() => void refreshDiagnostics()} className="settings-soft-button">
              <RefreshCw className={cn('h-3.5 w-3.5', busy === 'refresh' && 'animate-spin')} />
              {t('刷新')}
            </button>
            <button type="button" onClick={() => void copyLogs()} className="settings-soft-button">
              <Copy className="h-3.5 w-3.5" />
              {t('复制')}
            </button>
            <button type="button" onClick={exportLogs} className="settings-soft-button">
              <Download className="h-3.5 w-3.5" />
              {t('导出')}
            </button>
            <button type="button" onClick={clearLogs} className="settings-soft-button">{t('清空日志')}</button>
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm" style={{ color: 'var(--settings-muted-text)' }}>
            <span>{filteredLogs.length} / {logs.length} {t('条记录')}</span>
            <span>{debugEnabled ? t('调试模式已开启') : t('调试模式已关闭')}</span>
          </div>

          <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--settings-border)' }}>
            <div className="grid grid-cols-[6rem_5rem_5rem_13rem_1fr] px-3 py-2 text-xs font-semibold" style={{ background: 'var(--settings-panel-muted)', color: 'var(--settings-muted-text)' }}>
              <span>{t('时间')}</span><span>{t('级别')}</span><span>{t('来源')}</span><span>{t('模块')}</span><span>{t('内容')}</span>
            </div>
            <div ref={tableRef} className="max-h-[430px] overflow-auto">
              {filteredLogs.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm" style={{ color: 'var(--settings-muted-text)' }}>
                  {logs.length ? t('没有匹配的日志') : t('日志已清空，刷新后会重新写入诊断记录')}
                </div>
              ) : (
                filteredLogs.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[6rem_5rem_5rem_13rem_1fr] border-t px-3 py-3 text-sm"
                    style={{
                      borderColor: 'var(--settings-border)',
                      background: row.level === 'Error' ? 'var(--settings-danger-bg)' : row.level === 'Warn' ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
                    }}
                  >
                    <span className="font-mono text-xs" style={{ color: 'var(--settings-muted-text)' }}>{row.time}</span>
                    <span><ConsoleLevelPill level={row.level} /></span>
                    <span className="font-medium" style={{ color: 'var(--settings-text)' }}>{t(row.source)}</span>
                    <span className="truncate font-mono text-xs font-semibold" style={{ color: 'var(--settings-text)' }} title={row.module}>{row.module}</span>
                    <span className="font-mono text-xs leading-5" style={{ color: 'var(--settings-text)' }}>{row.content}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <ConsoleDiagnosticCard
            icon={Database}
            title="本地数据"
            status={generalInfo?.storage.exists ? '目录可用' : '等待刷新'}
            detail={generalInfo?.storage.activeDataDir ?? '会话、配置、日志会写入 App Data'}
            action="打开日志目录"
            busy={busy === 'log'}
            onAction={() => void openPathWithFallback(generalInfo?.storage.logDir, 'log')}
          />
          <ConsoleDiagnosticCard
            icon={TerminalSquare}
            title="调试输出"
            status={debugEnabled ? '正在记录' : '未开启'}
            detail={generalInfo?.debug.dir ?? '可在通用设置中开启调试模式'}
            action="打开调试目录"
            busy={busy === 'debug'}
            onAction={() => void openPathWithFallback(generalInfo?.debug.dir, 'debug')}
          />
          <ConsoleDiagnosticCard
            icon={GitBranch}
            title="Git 运行时"
            status={generalInfo?.git.ok ? '可用' : '未检测到'}
            detail={generalInfo?.git.runtime ?? '用于 diff、撤回和文件变更分析'}
          />
          <ConsoleDiagnosticCard
            icon={FileText}
            title="Python 运行时"
            status={generalInfo?.python.ok ? '可用' : '未检测到'}
            detail={generalInfo?.python.runtime ?? '用于脚本工具和文档处理'}
          />
        </div>
      </div>
    </div>
  )
}

function ConsoleMetric({ icon: Icon, label, value, detail, ok }: { icon: LucideIcon; label: string; value: number | string; detail: string; ok: boolean }) {
  const { t } = useI18n()
  return (
    <div className="rounded-2xl border p-4 shadow-sm" style={{ background: 'var(--settings-panel)', borderColor: 'var(--settings-border)' }}>
      <div className="mb-4 flex items-center justify-between">
        <span className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: 'var(--settings-accent-soft)', color: 'var(--settings-accent)' }}>
          <Icon className="h-4 w-4" />
        </span>
        <span className={cn('h-2.5 w-2.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-amber-500')} />
      </div>
      <div className="text-2xl font-semibold" style={{ color: 'var(--settings-text)' }}>{value}</div>
      <div className="mt-1 text-sm font-medium" style={{ color: 'var(--settings-text)' }}>{t(label)}</div>
      <div className="mt-2 truncate text-xs" style={{ color: 'var(--settings-muted-text)' }} title={detail}>{t(detail)}</div>
    </div>
  )
}

function ConsoleLevelPill({ level }: { level: ConsoleLogLevel }) {
  const color =
    level === 'Error'
      ? 'text-red-600 bg-red-50 border-red-200'
      : level === 'Warn'
        ? 'text-amber-700 bg-amber-50 border-amber-200'
        : level === 'Info'
          ? 'text-sky-700 bg-sky-50 border-sky-200'
          : level === 'Debug'
            ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
            : 'text-neutral-600 bg-neutral-50 border-neutral-200'
  return <span className={cn('inline-flex h-6 items-center rounded-full border px-2 text-xs font-semibold', color)}>{level}</span>
}

function ConsoleDiagnosticCard({
  icon: Icon,
  title,
  status,
  detail,
  action,
  busy,
  onAction,
}: {
  icon: LucideIcon
  title: string
  status: string
  detail: string
  action?: string
  busy?: boolean
  onAction?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="rounded-2xl border p-4 shadow-sm" style={{ background: 'var(--settings-panel)', borderColor: 'var(--settings-border)' }}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--settings-panel-muted)', color: 'var(--settings-accent)' }}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold" style={{ color: 'var(--settings-text)' }}>{t(title)}</div>
            <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: 'var(--settings-accent-soft)', color: 'var(--settings-accent)' }}>{t(status)}</span>
          </div>
          <div className="mt-2 break-all text-xs leading-5" style={{ color: 'var(--settings-muted-text)' }}>{t(detail)}</div>
          {onAction && action && (
            <button type="button" disabled={busy} onClick={onAction} className="settings-soft-button mt-3">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
              {t(action)}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function formatConsoleLogs(rows: ConsoleLogRow[]) {
  return rows.map((row) => `[${row.time}] ${row.level.padEnd(5)} ${row.source} ${row.module} - ${row.content}`).join('\n')
}

function SmallToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="relative h-6 w-10 rounded-full transition" style={{ background: checked ? 'var(--settings-accent)' : 'var(--settings-muted)' }}>
      <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white transition', checked ? 'left-5' : 'left-1')} />
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2" style={{ background: 'var(--settings-panel-muted)' }}>
      <span className="text-sm" style={{ color: 'var(--settings-muted-text)' }}>{t(label)}</span>
      <span className="text-sm font-medium" style={{ color: 'var(--settings-text)' }}>{value}</span>
    </div>
  )
}

function parentDirectory(path: string | undefined) {
  if (!path) return undefined
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return index > 0 ? normalized.slice(0, index) : normalized
}

function sectionDescription(section: SectionKey) {
  const descriptions: Record<SectionKey, string> = {
    显示: '选择窗口颜色、强调色，并预览聊天与工具面板的显示效果。',
    通用: '配置启动行为、语言、保存策略和基础交互习惯。',

    快捷键: '管理高频操作快捷键，提升聊天和编程效率。',
    工具权限: '配置 Agent 可调用的工具、MCP 服务、自动化钩子和敏感操作确认。',
    归档会话: '管理归档会话的保留、恢复和清理策略。',
    控制台: '管理外部连接、Git、本地环境、工作树和浏览器预览环境。',
    关于: '查看 AgentHub 客户端和本机运行信息。',
  }
  return descriptions[section]
}

function createSettingsThemeStyle(settings: AppSettings): CSSProperties {
  const theme = resolveTheme(settings.mainWindowTheme)
  const palette = themePalette(theme)
  const accent = accentColor(settings.accent)
  const isDark = theme === 'dark'
  const readableAccent = readableAccentColor(accent, isDark)

  return {
    '--settings-bg': palette.bg,
    '--settings-sidebar': palette.chrome,
    '--settings-panel': palette.panel,
    '--settings-panel-muted': isDark ? '#1d1d1d' : '#f4f4ef',
    '--settings-control-bg': isDark ? '#202020' : '#ffffff',
    '--settings-border': palette.border,
    '--settings-text': palette.text,
    '--settings-muted': palette.muted,
    '--settings-muted-text': isDark ? '#a3a3a3' : '#666660',
    '--settings-accent': readableAccent,
    '--settings-accent-soft': hexToRgba(readableAccent, isDark ? 0.18 : 0.12),
    '--settings-active-bg': hexToRgba(readableAccent, isDark ? 0.16 : 0.1),
    '--settings-active-border': hexToRgba(readableAccent, isDark ? 0.42 : 0.32),
    '--settings-danger-bg': isDark ? '#2a1717' : '#fff7f7',
  } as CSSProperties
}
