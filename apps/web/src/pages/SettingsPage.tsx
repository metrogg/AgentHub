import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  CheckCircle2,
  Blocks,
  Info,
  Keyboard,
  LockKeyhole,
  Loader2,
  Monitor,
  Plus,
  Settings,
  Shield,
  TerminalSquare,
  X,
} from 'lucide-react'
import { api, type SettingsGeneralInfo } from '../lib/api'
import { languageToSettingValue, normalizeLanguage, useI18n } from '../lib/i18n'
import { getDesktopInfo, openPath, pickWorkspaceFolder } from '../lib/native'
import { cn } from '../lib/utils'

type SectionKey =
  | '通用'
  | '显示'
  | '快捷键'
  | '模型管理'
  | '默认模型'
  | '工具权限'
  | '归档会话'
  | '控制台'
  | '关于'

const sections: Array<{ icon: typeof Settings; label: SectionKey }> = [
  { icon: Settings, label: '通用' },
  { icon: Monitor, label: '显示' },
  { icon: Keyboard, label: '快捷键' },
  { icon: Shield, label: '模型管理' },
  { icon: Blocks, label: '默认模型' },
  { icon: LockKeyhole, label: '工具权限' },
  { icon: Archive, label: '归档会话' },
  { icon: TerminalSquare, label: '控制台' },
  { icon: Info, label: '关于' },
]

interface ModelConfig {
  id: string
  enabled: boolean
  name: string
  provider: string
  modelId: string
  apiEndpoint: string
  anthropicEndpoint: string
  apiKeyEnv: string
  apiKey: string
  temperature: string
  topP: string
  maxTokens: string
  tested: boolean
}

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
  embeddedWindowTheme: string
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
}

const defaultModels: ModelConfig[] = [
  model('claude', 'Anthropic Claude', 'anthropic', 'claude-sonnet-4-6', 'https://api.anthropic.com', '', 'ANTHROPIC_API_KEY'),
  model('openai', 'OpenAI', 'openai', 'gpt-4.1', 'https://api.openai.com/v1', '', 'OPENAI_API_KEY'),
  model('deepseek', 'deepseek', 'deepseek', 'deepseek-chat', 'https://api.deepseek.com', 'https://api.deepseek.com/anthropic', 'DEEPSEEK_API_KEY'),
]

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
  gitEmail: 'agenthub@example.com',
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
  embeddedWindowTheme: '暗色',
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
}

function model(
  id: string,
  name: string,
  provider: string,
  modelId: string,
  apiEndpoint: string,
  anthropicEndpoint: string,
  apiKeyEnv: string
): ModelConfig {
  return {
    id,
    enabled: true,
    name,
    provider,
    modelId,
    apiEndpoint,
    anthropicEndpoint,
    apiKeyEnv,
    apiKey: '',
    temperature: '0.7',
    topP: '0.9',
    maxTokens: '4096',
    tested: false,
  }
}

const emptyDraft = model('', '', '', '', '', '', '')

export default function SettingsPage() {
  const navigate = useNavigate()
  const { setLanguage, t } = useI18n()
  const [activeSection, setActiveSection] = useState<SectionKey>('通用')
  const [models, setModels] = useState<ModelConfig[]>(defaultModels)
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings)
  const [activeModelId, setActiveModelId] = useState(defaultModels[0].id)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [draft, setDraft] = useState<ModelConfig>({ ...emptyDraft, id: crypto.randomUUID(), enabled: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMessages, setTestMessages] = useState<Record<string, string>>({})

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        if (settings.MODEL_CATALOG) {
          try {
            const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelConfig[]
            if (Array.isArray(parsed) && parsed.length) setModels(parsed)
          } catch {
            setModels(defaultModels)
          }
        }
        if (settings.APP_SETTINGS) {
          try {
            const parsed = JSON.parse(settings.APP_SETTINGS) as Partial<AppSettings>
            const normalizedLanguage = normalizeLanguage(parsed.language)
            setLanguage(normalizedLanguage)
            setAppSettings({
              ...defaultAppSettings,
              ...parsed,
              language: languageToSettingValue(normalizedLanguage),
            })
          } catch {
            setAppSettings(defaultAppSettings)
          }
        }
        setActiveModelId(settings.ACTIVE_MODEL_ID ?? settings.MODEL_PROVIDER ?? defaultModels[0].id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading) return
    const timer = window.setTimeout(() => {
      const selected = models.find((item) => item.id === activeModelId) ?? models[0]
      setSaveState('saving')
      void api.saveSettings({
        APP_SETTINGS: JSON.stringify(appSettings),
        MODEL_CATALOG: JSON.stringify(models),
        ACTIVE_MODEL_ID: selected?.id ?? '',
        MODEL_PROVIDER: selected?.provider ?? '',
        MODEL_API_KEY: selected?.apiKey ?? '',
        MODEL_BASE_URL: selected?.apiEndpoint ?? '',
        MODEL_NAME: selected?.modelId ?? '',
        ACTIVE_PROVIDER: selected?.provider ?? '',
        ACTIVE_API_KEY: selected?.apiKey ?? '',
        ACTIVE_BASE_URL: selected?.apiEndpoint ?? '',
        ACTIVE_MODEL: selected?.modelId ?? '',
        ANTHROPIC_API_KEY: selected?.provider === 'anthropic' ? selected.apiKey : '',
        ANTHROPIC_MODEL: selected?.provider === 'anthropic' ? selected.modelId : 'claude-sonnet-4-6',
      })
        .then(() => {
          setSaveState('saved')
          window.setTimeout(() => setSaveState('idle'), 2500)
        })
        .catch(() => setSaveState('error'))
    }, 650)
    return () => window.clearTimeout(timer)
  }, [activeModelId, appSettings, loading, models])

  function patchSettings(patch: Partial<AppSettings>) {
    setAppSettings((current) => ({ ...current, ...patch }))
  }

  function updateModel(id: string, patch: Partial<ModelConfig>) {
    setModels((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function openCreate() {
    setEditingId(null)
    setDraft({ ...emptyDraft, id: crypto.randomUUID(), enabled: true })
    setShowEditor(true)
  }

  function openEdit(item: ModelConfig) {
    setEditingId(item.id)
    setDraft({ ...item })
    setShowEditor(true)
  }

  function saveDraft() {
    if (!draft.name || !draft.provider || !draft.modelId || !draft.apiEndpoint) return
    if (editingId) {
      setModels((current) => current.map((item) => (item.id === editingId ? draft : item)))
    } else {
      setModels((current) => [...current, draft])
      setActiveModelId(draft.id)
    }
    setShowEditor(false)
  }

  function deleteModel(id: string) {
    setModels((current) => {
      if (current.length <= 1) return current
      const next = current.filter((item) => item.id !== id)
      if (activeModelId === id) setActiveModelId(next[0].id)
      return next
    })
  }

  async function testModel(item: ModelConfig) {
    setTestingId(item.id)
    setTestMessages((current) => ({ ...current, [item.id]: '' }))
    try {
      const result = await api.testModel({
        provider: item.provider,
        apiEndpoint: item.apiEndpoint,
        anthropicEndpoint: item.anthropicEndpoint,
        apiKey: item.apiKey,
        apiKeyEnv: item.apiKeyEnv,
      })
      updateModel(item.id, { tested: result.ok })
      setTestMessages((current) => ({ ...current, [item.id]: result.ok ? t('连接成功') : result.message }))
    } catch (error: any) {
      updateModel(item.id, { tested: false })
      setTestMessages((current) => ({ ...current, [item.id]: error?.message || t('连接失败') }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[#f7f7f4] text-neutral-950">
      <SettingsSidebar
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        navigateBack={() => navigate(-1)}
      />

      <main className="min-h-0 flex-1 overflow-y-auto bg-[#f7f7f4] px-10 py-9">
        <div className="max-w-6xl">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal">{t(activeSection)}</h1>
              <p className="mt-1 text-sm text-neutral-500">{t(sectionDescription(activeSection))}</p>
            </div>
            <AutoSaveStatus state={saveState} />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('加载中...')}
            </div>
          ) : activeSection === '模型管理' || activeSection === '默认模型' ? (
            <ModelManagement
              models={models}
              activeModelId={activeModelId}
              setActiveModelId={setActiveModelId}
              updateModel={updateModel}
              openCreate={openCreate}
              openEdit={openEdit}
              deleteModel={deleteModel}
              testModel={testModel}
              testingId={testingId}
              testMessages={testMessages}
            />
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

      {showEditor && (
        <ModelEditor
          draft={draft}
          setDraft={setDraft}
          onClose={() => setShowEditor(false)}
          onSave={saveDraft}
          editing={Boolean(editingId)}
        />
      )}
    </div>
  )
}

function SettingsSidebar({
  activeSection,
  setActiveSection,
  navigateBack,
}: {
  activeSection: SectionKey
  setActiveSection: (section: SectionKey) => void
  navigateBack: () => void
}) {
  const { t } = useI18n()
  return (
    <aside className="h-full w-[260px] shrink-0 overflow-hidden border-r border-neutral-200 bg-[#f7f7f4] px-5 py-5">
      <div className="mb-7 flex items-center justify-between px-1">
        <div className="text-sm font-semibold text-neutral-800">{t('设置')}</div>
        <button
          type="button"
          onClick={navigateBack}
          className="grid h-6 w-6 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-900"
          aria-label={t('关闭设置')}
          title={t('关闭设置')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <nav className="space-y-3">
        {sections.map((section) => (
          <button
            key={section.label}
            onClick={() => setActiveSection(section.label)}
            className={cn(
              'flex h-6 w-full items-center gap-3 rounded-md px-1 text-sm font-medium text-neutral-600 transition hover:text-neutral-900',
              activeSection === section.label && 'text-neutral-950'
            )}
          >
            <section.icon className={cn('h-4 w-4 text-neutral-400', activeSection === section.label && 'text-neutral-950')} />
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
    const opened = await openPath(settings.dataPath)
    if (!opened) throw new Error(t('当前环境不支持直接打开目录'))
    showActionMessage(t('已打开数据目录'))
  }

  async function openDebugDirectory() {
    const target = generalInfo?.debug.dir
    if (!target) throw new Error(t('调试目录尚未生成'))
    const opened = await openPath(target)
    if (!opened) throw new Error(t('当前环境不支持直接打开目录'))
    showActionMessage(t('已打开调试目录'))
  }

  async function changeDataDirectory() {
    const path = await pickWorkspaceFolder()
    if (!path) {
      showActionMessage(t('已取消选择'))
      return
    }
    patchSettings({ dataPath: path })
    showActionMessage(t('数据目录已更新，重启后生效'))
  }

  function patchDebugMode(debugMode: boolean) {
    patchSettings({ debugMode })
    setGeneralInfo((current) => current ? { ...current, debug: { ...current.debug, enabled: debugMode } } : current)
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
          <SettingsSection title="界面语言" desc="切换界面显示语言">
            <SegmentedControl value={languageToSettingValue(normalizeLanguage(settings.language))} options={['中文', 'English']} onChange={patchLanguage} />
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
              <InfoRow label="当前位置" value={settings.dataPath} />
              <InfoRow label="已用空间" value={settings.dataUsed} />
              <InfoRow label="App Data" value={generalInfo?.storage.appDataDir ?? t('等待刷新')} />
              <InfoRow label="日志目录" value={generalInfo?.storage.logDir ?? t('等待刷新')} />
              <InfoRow label="数据库文件" value={generalInfo?.storage.databasePath ?? t('等待刷新')} />
              {generalInfo?.storage.message && <Notice tone="warning">{generalInfo.storage.message}</Notice>}
              {generalInfo?.storage.truncated && <Notice tone="warning">{t('目录较大，已展示扫描上限内的估算体积')}</Notice>}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busyAction === 'open-data'} onClick={() => void runAction('open-data', openDataDirectory)} className="settings-soft-button">{t('打开目录')}</button>
                <button type="button" disabled={busyAction === 'change-data'} onClick={() => void runAction('change-data', changeDataDirectory)} className="settings-soft-button">{t('更改位置')}</button>
                <button type="button" disabled={busyAction === 'general-info'} onClick={() => void runAction('general-info', refreshGeneralInfo)} className="settings-soft-button">{t('重新计算占用')}</button>
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
          <SettingsSection title="重置所有设置" desc="清除当前配置并重新进入初始引导">
            <button type="button" onClick={resetAllSettings} className="settings-danger-button">{t('重置所有设置')}</button>
          </SettingsSection>
        </SettingsStack>
      )
    case '显示':
      return (
        <SettingsStack>
          <SettingsSection title="主题" desc="分别选择主窗口和嵌入窗口的颜色风格">
            <OptionRow label="主窗口">
              <SegmentedControl value={settings.mainWindowTheme} options={['跟随系统', '亮色', '暗色']} onChange={(mainWindowTheme) => patchSettings({ mainWindowTheme })} />
            </OptionRow>
            <OptionRow label="嵌入窗口">
              <SegmentedControl value={settings.embeddedWindowTheme} options={['跟随系统', '亮色', '暗色']} onChange={(embeddedWindowTheme) => patchSettings({ embeddedWindowTheme })} />
            </OptionRow>
          </SettingsSection>
          <SettingsSection title="面板行为" desc="控制 TODO 和文件修改面板的自动打开/关闭行为">
            <SwitchList
              items={[
                ['收到 TODO 时自动打开 TODO 面板', settings.autoOpenTodo, (value) => patchSettings({ autoOpenTodo: value })],
                ['产生文件修改时自动打开文件修改面板', settings.autoOpenFileChanges, (value) => patchSettings({ autoOpenFileChanges: value })],
                ['发送新消息时自动关闭文件修改面板', settings.autoCloseFileChanges, (value) => patchSettings({ autoCloseFileChanges: value })],
                ['会话窗口中将用户消息右对齐', settings.userMessagesRight, (value) => patchSettings({ userMessagesRight: value })],
                ['折叠已完成的工具调用', settings.collapseCompletedTools, (value) => patchSettings({ collapseCompletedTools: value })],
                ['隐藏已完成思考块', settings.hideCompletedThoughts, (value) => patchSettings({ hideCompletedThoughts: value })],
              ]}
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
          <SettingsSection title="字体" desc="自定义各区域使用的字体，留空则使用默认字体栈">
            <SelectLine label="界面" value={settings.uiFont} onChange={(uiFont) => patchSettings({ uiFont })} />
            <SelectLine label="正文" value={settings.bodyFont} onChange={(bodyFont) => patchSettings({ bodyFont })} />
            <SelectLine label="行内代码" value={settings.inlineCodeFont} onChange={(inlineCodeFont) => patchSettings({ inlineCodeFont })} />
            <SelectLine label="代码块" value={settings.codeBlockFont} onChange={(codeBlockFont) => patchSettings({ codeBlockFont })} />
            <SelectLine label="编辑器 / 终端" value={settings.terminalFont} onChange={(terminalFont) => patchSettings({ terminalFont })} />
          </SettingsSection>
        </SettingsStack>
      )
    case '快捷键':
      return (
        <SettingsStack>
          <SettingsSection title="快捷键" desc="配置常用操作的键盘组合。">
            <InsetPanel>
              <ShortcutRow title="发送方式" desc="设置会话输入框里 Enter 与 Ctrl+Enter 的发送和换行行为。">
                <SelectPill value={settings.sendMode} options={['Enter 发送', 'Ctrl+Enter 发送']} onChange={(sendMode) => patchSettings({ sendMode })} />
              </ShortcutRow>
              <ShortcutRow title="新建会话" desc="在会话页立即开始一个新会话。">
                <div className="flex items-center gap-2">
                  <Keycap>Ctrl</Keycap>
                  <Keycap>N</Keycap>
                  <button type="button" className="settings-soft-button">{t('录制')}</button>
                  <button type="button" className="settings-soft-button">{t('恢复默认')}</button>
                </div>
              </ShortcutRow>
            </InsetPanel>
            <p className="text-xs text-neutral-500">{t('点击“录制”后按下组合键。至少包含 Ctrl、Alt、Shift 或 Cmd，按 Esc 取消。')}</p>
          </SettingsSection>
        </SettingsStack>
      )
    case '工具权限':
      return (
        <SettingsStack>
          <SettingsSection title="工具权限" desc="设置工具整体执行方式，并在 Ask 模式下为单个工具指定确认规则。">
            <InsetPanel>
              <ShortcutRow title="工具执行模式" desc="Auto 自动执行所有工具；Ask 按下方规则确认。">
                <SegmentedControl value={settings.toolPermissionMode} options={['Auto', 'Ask']} onChange={(toolPermissionMode) => patchSettings({ toolPermissionMode })} />
              </ShortcutRow>
            </InsetPanel>
            <ToolPermissionTable
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
            <div className="grid min-h-[680px] grid-cols-[280px_minmax(0,1fr)] overflow-hidden rounded-xl border border-neutral-200 bg-white">
              <div className="flex flex-col border-r border-neutral-200 bg-neutral-50">
                <div className="flex h-10 items-center justify-between border-b border-neutral-200 px-3">
                  <span className="text-sm font-semibold">{t('会话列表')}</span>
                  <button type="button" className="settings-soft-button h-7 px-3">{t('刷新')}</button>
                </div>
                <div className="grid flex-1 place-items-center px-6 text-center">
                  <div>
                    <div className="text-sm font-semibold text-neutral-900">{t('暂无归档会话')}</div>
                    <div className="mt-2 text-xs text-neutral-500">{t('归档后的会话会显示在这里。')}</div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col">
                <div className="flex h-10 items-center border-b border-neutral-200 px-3 text-sm font-semibold">{t('会话内容')}</div>
                <div className="grid flex-1 place-items-center text-sm text-neutral-500">{t('选择左侧会话后，在这里查看归档内容。')}</div>
              </div>
            </div>
          </SettingsSection>
        </SettingsStack>
      )
    case '控制台':
      return (
        <SettingsStack>
          <SettingsSection title="控制台" desc="查看前端与后端的统一调试输出。后端 debug 与 trace 级别日志受“通用 > 调试模式”控制。">
            <ConsolePanel debugEnabled={settings.debugMode} />
          </SettingsSection>
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
                <span className="text-neutral-500">{t('联系邮箱')}</span><span className="font-medium">agenthub@example.com</span>
                <span className="text-neutral-500">{t('版本来源')}</span><span className="font-medium">{t('本地开发版')}</span>
                <span className="text-neutral-500">{t('上次检查')}</span><span><button type="button" className="settings-soft-button">{t('检查更新')}</button></span>
              </div>
            </div>
          </SettingsSection>
        </SettingsStack>
      )
    default:
      return null
  }
}

function ModelManagement({
  models,
  activeModelId,
  setActiveModelId,
  updateModel,
  openCreate,
  openEdit,
  deleteModel,
  testModel,
  testingId,
  testMessages,
}: {
  models: ModelConfig[]
  activeModelId: string
  setActiveModelId: (id: string) => void
  updateModel: (id: string, patch: Partial<ModelConfig>) => void
  openCreate: () => void
  openEdit: (item: ModelConfig) => void
  deleteModel: (id: string) => void
  testModel: (item: ModelConfig) => void
  testingId: string | null
  testMessages: Record<string, string>
}) {
  const { t } = useI18n()
  const configuredCount = models.filter((item) => item.apiKey || item.apiKeyEnv).length
  const enabledCount = models.filter((item) => item.enabled).length
  const testedCount = models.filter((item) => item.tested).length

  return (
    <div>
      <div className="mb-6 flex justify-end">
        <button type="button" onClick={openCreate} className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700">
          <Plus className="h-4 w-4" />
          {t('添加模型')}
        </button>
      </div>

      <div className="mb-6 flex w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
        <Stat value={models.length} label="模型总数" />
        <Stat value={enabledCount} label="已启用" />
        <Stat value={configuredCount} label="API Key 已配置" />
        <Stat value={testedCount} label="已测试连接" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-xs font-medium text-neutral-500">
            <tr>
              <th className="w-20 px-4 py-3">{t('启用')}</th>
              <th className="px-4 py-3">{t('名称')}</th>
              <th className="px-4 py-3">{t('提供商')}</th>
              <th className="px-4 py-3">{t('模型 ID')}</th>
              <th className="px-4 py-3">{t('API 端点')}</th>
              <th className="px-4 py-3">API Key</th>
              <th className="px-4 py-3">{t('连接')}</th>
              <th className="px-4 py-3">{t('操作')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {models.map((item) => (
              <tr key={item.id} className={cn(activeModelId === item.id && 'bg-neutral-50')}>
                <td className="px-4 py-3">
                  <SmallToggle checked={item.enabled} onChange={(enabled) => updateModel(item.id, { enabled })} />
                </td>
                <td className="px-4 py-3 font-medium text-neutral-800">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={activeModelId === item.id} onChange={() => setActiveModelId(item.id)} />
                    {item.name}
                  </label>
                </td>
                <td className="px-4 py-3 text-neutral-500">{item.provider}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-800">{item.modelId}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                  <div>{item.apiEndpoint}</div>
                  {item.anthropicEndpoint && <div className="mt-1 text-sky-600">Anthropic: {item.anthropicEndpoint}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="font-mono text-xs text-neutral-600">{item.apiKeyEnv || t('自动生成')}</div>
                  {(item.apiKey || item.apiKeyEnv) && <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">{t('已设置')}</span>}
                </td>
                <td className="px-4 py-3">
                  <button type="button" onClick={() => testModel(item)} disabled={testingId === item.id} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
                    {testingId === item.id ? t('测试中') : t('测试')}
                  </button>
                  {testMessages[item.id] && (
                    <div className={cn('mt-1 max-w-[160px] truncate text-xs', item.tested ? 'text-emerald-600' : 'text-red-500')} title={testMessages[item.id]}>
                      {testMessages[item.id]}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3 text-xs">
                    <button type="button" onClick={() => openEdit(item)} className="text-sky-600 hover:underline">{t('编辑')}</button>
                    <button type="button" onClick={() => deleteModel(item.id)} className="text-red-500 hover:underline">{t('删除')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-neutral-400">{t('提示：模型变更会自动保存并同步到聊天后端。不同 API 协议的 CLI 工具配置在“Coding Tools”页面管理。')}</p>
    </div>
  )
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
        <h2 className="text-sm font-semibold text-slate-800">{t(title)}</h2>
        {desc && <p className="mt-2 text-sm leading-6 text-slate-600">{t(desc)}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function InsetPanel({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-4">{children}</div>
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
      <span className="text-sm font-medium text-neutral-800">{t(label)}</span>
    </div>
  )
}

function SegmentedControl({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-neutral-200 bg-white p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            'h-7 min-w-14 px-3 text-sm transition',
            value === option ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-neutral-50'
          )}
        >
          {t(option)}
        </button>
      ))}
    </div>
  )
}

function OptionRow({ label, children }: { label: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-5">
      <span className="w-24 text-sm text-slate-600">{t(label)}</span>
      {children}
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

function SelectLine({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="flex max-w-[470px] items-center gap-4">
      <span className="w-24 text-right text-sm text-slate-600">{t(label)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium outline-none">
        {['默认', 'Inter', 'Microsoft YaHei UI', 'JetBrains Mono', 'Cascadia Mono'].map((option) => <option key={option} value={option}>{t(option)}</option>)}
      </select>
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
    <div className="flex min-h-16 items-center justify-between gap-6 rounded-xl border border-neutral-200 px-4 py-3">
      <div>
        <div className="text-sm font-semibold text-neutral-950">{t(title)}</div>
        <div className="mt-1 text-sm text-neutral-500">{t(desc)}</div>
      </div>
      {children}
    </div>
  )
}

function SelectPill({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-80 rounded-md border border-neutral-200 bg-white px-3 text-center text-sm font-medium outline-none">
      {options.map((option) => <option key={option} value={option}>{t(option)}</option>)}
    </select>
  )
}

function Keycap({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm font-semibold shadow-sm">{children}</span>
}

const toolRows = [
  ['read', '读取文件'],
  ['grep', '搜索文件内容'],
  ['list', '列出目录内容'],
  ['task', '委托子 Agent'],
  ['todowrite', '管理待办事项'],
  ['ask_user_question', '向用户询问'],
  ['unity_yaml_search', '搜索 Unity YAML 层级'],
  ['unity_yaml_read', '读取 Unity YAML 详情'],
  ['knowledge_list', '列出知识文档'],
  ['knowledge_query', '搜索知识文档'],
  ['knowledge_read', '读取知识条目'],
  ['knowledge_create', '创建知识条目'],
  ['knowledge_delete', '删除知识条目'],
  ['knowledge_move', '移动知识条目'],
  ['knowledge_edit', '编辑知识条目'],
]

function ToolPermissionTable({ permissions, onChange }: { permissions: Record<string, string>; onChange: (name: string, value: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="grid grid-cols-[1fr_auto] border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-xs font-semibold text-slate-600">
        <span>{t('工具')}</span>
        <span>{t('执行方式')}</span>
      </div>
      {toolRows.map(([name, desc]) => (
        <div key={name} className="grid grid-cols-[1fr_auto] items-center border-b border-neutral-200 px-4 py-3 last:border-b-0">
          <div>
            <div className="font-mono text-sm font-semibold text-neutral-950">{name}</div>
            <div className="mt-1 text-xs text-slate-600">{t(desc)}</div>
          </div>
          <SegmentedControl value={permissions[name] ?? 'Auto'} options={['Auto', 'Ask']} onChange={(value) => onChange(name, value)} />
        </div>
      ))}
    </div>
  )
}

const consoleRows = [
  ['13:04:01', '后端', 'asset_db::watcher', '- Assets/AgentHub/workspace/ReadMe & Inspector Info/Icons [new-meta]'],
  ['13:04:01', '后端', 'AssetDb Watcher', 'queue summary: pending=0, current=-, recent=1 in 8s, reasons=[new-meta=1]'],
  ['13:03:59', '后端', 'AssetDb Watcher', 'worker 1 error processing workspace icons: No GUID in generated file metadata'],
  ['12:53:45', '前端', 'settings', 'settings panel rendered and preferences persisted'],
  ['12:43:29', '后端', 'agent-runtime', 'code agent stream connected, waiting for output chunks'],
]

function ConsolePanel({ debugEnabled }: { debugEnabled: boolean }) {
  const { t } = useI18n()
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl value="全部级别" options={['全部级别', 'Trace', 'Debug', 'Info', 'Warn', 'Error']} onChange={() => undefined} />
        <SegmentedControl value="全部来源" options={['全部来源', '后端', '前端']} onChange={() => undefined} />
        <InlineSwitch checked onChange={() => undefined} label="自动滚动" />
        <input className="h-8 min-w-64 flex-1 rounded-md border border-neutral-200 px-3 text-sm outline-none" placeholder={t('按模块名或日志内容筛选')} />
        <button type="button" className="settings-soft-button">{t('刷新')}</button>
        <button type="button" className="settings-soft-button">{t('清空日志')}</button>
      </div>
      <div className="mb-3 flex items-center justify-between text-sm text-slate-600">
        <span>{t('804 条记录')}</span>
        <span>{debugEnabled ? t('调试模式已开启') : t('调试模式已关闭')}</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        <div className="grid grid-cols-[6rem_5rem_14rem_1fr] bg-neutral-50 px-3 py-2 text-xs font-medium text-slate-600">
          <span>{t('时间')}</span><span>{t('来源')}</span><span>{t('模块')}</span><span>{t('内容')}</span>
        </div>
        {consoleRows.map((row, index) => (
          <div key={`${row[0]}-${index}`} className={cn('grid grid-cols-[6rem_5rem_14rem_1fr] border-t border-neutral-200 px-3 py-3 text-xs', row[3].includes('error') && 'bg-red-50/60')}>
            <span className="font-mono">{row[0]}</span>
            <span>{t(row[1])}</span>
            <span className="font-mono font-semibold">{row[2]}</span>
            <span className="font-mono leading-5">{row[3]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SmallToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className={cn('relative h-6 w-10 rounded-full transition', checked ? 'bg-indigo-500' : 'bg-neutral-300')}>
      <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white transition', checked ? 'left-5' : 'left-1')} />
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-neutral-50 px-3 py-2">
      <span className="text-sm text-neutral-500">{t(label)}</span>
      <span className="text-sm font-medium text-neutral-900">{value}</span>
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  const { t } = useI18n()
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 border-r border-neutral-200 px-4 py-3 last:border-r-0">
      <span className="text-xl font-medium text-neutral-900">{value}</span>
      <span className="text-xs text-neutral-500">{t(label)}</span>
    </div>
  )
}

function ModelEditor({
  draft,
  setDraft,
  onClose,
  onSave,
  editing,
}: {
  draft: ModelConfig
  setDraft: (draft: ModelConfig) => void
  onClose: () => void
  onSave: () => void
  editing: boolean
}) {
  const { t } = useI18n()
  const patch = (value: Partial<ModelConfig>) => setDraft({ ...draft, ...value })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6">
      <div className="w-full max-w-4xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editing ? t('编辑模型') : t('添加模型')}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Field label="名称（唯一标识）*" value={draft.name} onChange={(name) => patch({ name })} placeholder="例如：qwen-max" />
          <Field label="提供商 *" value={draft.provider} onChange={(provider) => patch({ provider })} placeholder="例如：dashscope / openai / deepseek" />
          <Field label="模型 ID *" value={draft.modelId} onChange={(modelId) => patch({ modelId })} placeholder="例如：qwen-max-2026-04-01" />
          <Field label="API Key 环境变量名" value={draft.apiKeyEnv} onChange={(apiKeyEnv) => patch({ apiKeyEnv })} placeholder="留空自动生成" />
          <Field label="API 端点（OpenAI 兼容）*" value={draft.apiEndpoint} onChange={(apiEndpoint) => patch({ apiEndpoint })} placeholder="https://api.example.com/v1" wide />
          <Field label="Anthropic 端点（Claude Code 使用，可选）" value={draft.anthropicEndpoint} onChange={(anthropicEndpoint) => patch({ anthropicEndpoint })} placeholder="例如：https://api.deepseek.com/anthropic" wide />
          <Field label="API Key（同步到本地设置）" value={draft.apiKey} onChange={(apiKey) => patch({ apiKey })} placeholder="输入 API Key" type="password" />
          <Field label="temperature" value={draft.temperature} onChange={(temperature) => patch({ temperature })} placeholder="0.7" />
          <Field label="top_p" value={draft.topP} onChange={(topP) => patch({ topP })} placeholder="0.9" />
          <Field label="max_tokens" value={draft.maxTokens} onChange={(maxTokens) => patch({ maxTokens })} placeholder="4096" />
        </div>

        <label className="mt-5 flex items-center gap-2 text-sm text-neutral-700">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
          {t('启用此模型')}
        </label>

        <div className="mt-7 flex justify-end gap-3">
          <button onClick={onClose} className="h-9 rounded-lg border border-neutral-200 px-4 text-sm text-neutral-700 hover:bg-neutral-50">{t('取消')}</button>
          <button onClick={onSave} className="h-9 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-700">{editing ? t('保存') : t('添加')}</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', wide = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; wide?: boolean }) {
  const { t } = useI18n()
  return (
    <label className={cn('block', wide && 'md:col-span-2')}>
      <span className="mb-1.5 block text-xs font-medium text-neutral-500">{t(label)}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="settings-input font-mono" placeholder={placeholder ? t(placeholder) : undefined} />
    </label>
  )
}

function sectionDescription(section: SectionKey) {
  const descriptions: Record<SectionKey, string> = {
    通用: '配置启动行为、语言、保存策略和基础交互习惯。',
    显示: '调整主题、强调色、字体尺寸和聊天阅读密度。',
    快捷键: '管理高频操作快捷键，提升聊天和编程效率。',
    模型管理: '管理可用模型、API 端点、密钥变量和连接测试状态。',
    默认模型: '选择默认模型，并让聊天后端同步使用当前模型配置。',
    工具权限: '配置 Agent 可调用的工具、MCP 服务、自动化钩子和敏感操作确认。',
    归档会话: '管理归档会话的保留、恢复和清理策略。',
    控制台: '管理外部连接、Git、本地环境、工作树和浏览器预览环境。',
    关于: '查看 AgentHub 客户端和本机运行信息。',
  }
  return descriptions[section]
}
