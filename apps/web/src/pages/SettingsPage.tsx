import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  Bot,
  CheckCircle2,
  CircleGauge,
  Cpu,
  FolderGit2,
  Globe,
  Keyboard,
  Loader2,
  Monitor,
  Palette,
  Plus,
  Settings,
  Shield,
  TerminalSquare,
  Trash2,
  Unplug,
  Workflow,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'

type SectionKey =
  | '常规'
  | '外观'
  | '配置'
  | '个性化'
  | '键盘快捷键'
  | 'MCP 服务器'
  | '钩子'
  | '连接'
  | 'Git'
  | '环境'
  | '工作树'
  | '浏览器'
  | '电脑操控'
  | '已归档对话'

const sections: Array<{ icon: typeof Settings; label: SectionKey }> = [
  { icon: Settings, label: '常规' },
  { icon: Palette, label: '外观' },
  { icon: Shield, label: '配置' },
  { icon: CircleGauge, label: '个性化' },
  { icon: Keyboard, label: '键盘快捷键' },
  { icon: Unplug, label: 'MCP 服务器' },
  { icon: Bot, label: '钩子' },
  { icon: Globe, label: '连接' },
  { icon: FolderGit2, label: 'Git' },
  { icon: TerminalSquare, label: '环境' },
  { icon: Workflow, label: '工作树' },
  { icon: Monitor, label: '浏览器' },
  { icon: Cpu, label: '电脑操控' },
  { icon: Archive, label: '已归档对话' },
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
}

const defaultModels: ModelConfig[] = [
  model('claude', 'Anthropic Claude', 'anthropic', 'claude-sonnet-4-6', 'https://api.anthropic.com', '', 'ANTHROPIC_API_KEY'),
  model('openai', 'OpenAI', 'openai', 'gpt-4.1', 'https://api.openai.com/v1', '', 'OPENAI_API_KEY'),
  model('deepseek', 'deepseek', 'deepseek', 'deepseek-chat', 'https://api.deepseek.com', 'https://api.deepseek.com/anthropic', 'DEEPSEEK_API_KEY'),
]

const defaultAppSettings: AppSettings = {
  startupPage: '上次会话',
  language: '简体中文',
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
  const [activeSection, setActiveSection] = useState<SectionKey>('常规')
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
            setAppSettings({ ...defaultAppSettings, ...(JSON.parse(settings.APP_SETTINGS) as Partial<AppSettings>) })
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
        modelId: item.modelId,
      })
      updateModel(item.id, { tested: result.ok })
      setTestMessages((current) => ({ ...current, [item.id]: result.ok ? '连接成功' : result.message }))
    } catch (error: any) {
      updateModel(item.id, { tested: false })
      setTestMessages((current) => ({ ...current, [item.id]: error?.message || '连接失败' }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex min-h-screen bg-white text-neutral-950">
      <SettingsSidebar
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        navigateBack={() => navigate(-1)}
      />

      <main className="flex-1 px-10 py-9">
        <div className="max-w-6xl">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal">{activeSection === '配置' ? '模型管理' : activeSection}</h1>
              <p className="mt-1 text-sm text-neutral-500">{sectionDescription(activeSection)}</p>
            </div>
            <AutoSaveStatus state={saveState} />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : activeSection === '配置' ? (
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
  return (
    <aside className="w-[300px] border-r border-neutral-200 bg-[#f7f3ec] p-2">
      <button
        onClick={navigateBack}
        className="mb-2 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-neutral-700 hover:bg-black/5"
      >
        <Settings className="h-4 w-4" />
        返回
      </button>
      <nav className="space-y-1">
        {sections.map((section) => (
          <button
            key={section.label}
            onClick={() => setActiveSection(section.label)}
            className={cn(
              'flex h-8 w-full items-center gap-3 rounded-lg px-3 text-sm text-neutral-800 transition hover:bg-black/5',
              activeSection === section.label && 'bg-black/5'
            )}
          >
            <section.icon className="h-4 w-4 text-neutral-700" />
            {section.label}
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
}: {
  section: SectionKey
  settings: AppSettings
  patchSettings: (patch: Partial<AppSettings>) => void
}) {
  switch (section) {
    case '常规':
      return (
        <PanelGrid>
          <SettingCard title="启动与语言" desc="控制 AgentHub 打开时的默认位置和语言。">
            <SelectRow label="启动页面" value={settings.startupPage} options={['上次会话', '新会话', 'Agent Group', 'Code Agent']} onChange={(startupPage) => patchSettings({ startupPage })} />
            <SelectRow label="语言" value={settings.language} options={['简体中文', 'English']} onChange={(language) => patchSettings({ language })} />
          </SettingCard>
          <SettingCard title="基础行为" desc="让聊天记录和输入体验保持稳定。">
            <ToggleRow label="自动保存设置和草稿" checked={settings.autoSave} onChange={(autoSave) => patchSettings({ autoSave })} />
            <ToggleRow label="紧凑模式" checked={settings.compactMode} onChange={(compactMode) => patchSettings({ compactMode })} />
          </SettingCard>
        </PanelGrid>
      )
    case '外观':
      return (
        <PanelGrid>
          <SettingCard title="主题" desc="保持简洁、低干扰的工作界面。">
            <SelectRow label="颜色模式" value={settings.theme} options={['浅色', '深色', '跟随系统']} onChange={(theme) => patchSettings({ theme })} />
            <SelectRow label="强调色" value={settings.accent} options={['黑色', '蓝色', '绿色', '琥珀色']} onChange={(accent) => patchSettings({ accent })} />
          </SettingCard>
          <SettingCard title="阅读密度" desc="调整聊天消息和面板的视觉密度。">
            <SelectRow label="字体大小" value={settings.fontSize} options={['13', '14', '15', '16']} onChange={(fontSize) => patchSettings({ fontSize })} />
            <SelectRow label="消息样式" value={settings.bubbleStyle} options={['简洁', '气泡', '分栏']} onChange={(bubbleStyle) => patchSettings({ bubbleStyle })} />
          </SettingCard>
        </PanelGrid>
      )
    case '个性化':
      return (
        <PanelGrid>
          <SettingCard title="Agent 个性" desc="影响默认 Assistant 的回答语气。">
            <SelectRow label="默认风格" value={settings.personality} options={['温和理性', '直接高效', '详细解释', '创意探索']} onChange={(personality) => patchSettings({ personality })} />
            <SelectRow label="回答深度" value={settings.responseDepth} options={['自动', '简短', '标准', '深入']} onChange={(responseDepth) => patchSettings({ responseDepth })} />
            <ToggleRow label="行动前先规划" checked={settings.planBeforeAct} onChange={(planBeforeAct) => patchSettings({ planBeforeAct })} />
          </SettingCard>
        </PanelGrid>
      )
    case '键盘快捷键':
      return (
        <ListEditor
          title="快捷键"
          items={settings.shortcuts}
          columns={['动作', '按键']}
          onAdd={() => patchSettings({ shortcuts: [...settings.shortcuts, { action: '新动作', keys: 'Ctrl Shift K' }] })}
          onDelete={(index) => patchSettings({ shortcuts: settings.shortcuts.filter((_, i) => i !== index) })}
          render={(item, index) => (
            <>
              <InlineInput value={item.action} onChange={(action) => patchSettings({ shortcuts: replaceAt(settings.shortcuts, index, { ...item, action }) })} />
              <InlineInput value={item.keys} onChange={(keys) => patchSettings({ shortcuts: replaceAt(settings.shortcuts, index, { ...item, keys }) })} mono />
            </>
          )}
        />
      )
    case 'MCP 服务器':
      return (
        <ListEditor
          title="MCP 服务器"
          items={settings.mcpServers}
          columns={['名称', '启动命令', '启用']}
          onAdd={() => patchSettings({ mcpServers: [...settings.mcpServers, { id: crypto.randomUUID(), name: 'New MCP', command: 'npx server', enabled: false }] })}
          onDelete={(index) => patchSettings({ mcpServers: settings.mcpServers.filter((_, i) => i !== index) })}
          render={(item, index) => (
            <>
              <InlineInput value={item.name} onChange={(name) => patchSettings({ mcpServers: replaceAt(settings.mcpServers, index, { ...item, name }) })} />
              <InlineInput value={item.command} onChange={(command) => patchSettings({ mcpServers: replaceAt(settings.mcpServers, index, { ...item, command }) })} mono />
              <SmallToggle checked={item.enabled} onChange={(enabled) => patchSettings({ mcpServers: replaceAt(settings.mcpServers, index, { ...item, enabled }) })} />
            </>
          )}
        />
      )
    case '钩子':
      return (
        <ListEditor
          title="自动化钩子"
          items={settings.hooks}
          columns={['事件', '命令', '启用']}
          onAdd={() => patchSettings({ hooks: [...settings.hooks, { id: crypto.randomUUID(), event: '工具调用后', command: 'echo done', enabled: false }] })}
          onDelete={(index) => patchSettings({ hooks: settings.hooks.filter((_, i) => i !== index) })}
          render={(item, index) => (
            <>
              <InlineInput value={item.event} onChange={(event) => patchSettings({ hooks: replaceAt(settings.hooks, index, { ...item, event }) })} />
              <InlineInput value={item.command} onChange={(command) => patchSettings({ hooks: replaceAt(settings.hooks, index, { ...item, command }) })} mono />
              <SmallToggle checked={item.enabled} onChange={(enabled) => patchSettings({ hooks: replaceAt(settings.hooks, index, { ...item, enabled }) })} />
            </>
          )}
        />
      )
    case '连接':
      return (
        <ListEditor
          title="外部连接"
          items={settings.connections}
          columns={['服务', '地址', '状态']}
          onAdd={() => patchSettings({ connections: [...settings.connections, { id: crypto.randomUUID(), name: 'New Service', url: 'https://', status: '未连接' }] })}
          onDelete={(index) => patchSettings({ connections: settings.connections.filter((_, i) => i !== index) })}
          render={(item, index) => (
            <>
              <InlineInput value={item.name} onChange={(name) => patchSettings({ connections: replaceAt(settings.connections, index, { ...item, name }) })} />
              <InlineInput value={item.url} onChange={(url) => patchSettings({ connections: replaceAt(settings.connections, index, { ...item, url }) })} mono />
              <span className="text-xs text-neutral-500">{item.status}</span>
            </>
          )}
        />
      )
    case 'Git':
      return (
        <PanelGrid>
          <SettingCard title="Git 身份" desc="用于 Agent 生成提交信息、PR 描述和审查记录。">
            <ToggleRow label="自动检测仓库 Git 配置" checked={settings.gitAutoDetect} onChange={(gitAutoDetect) => patchSettings({ gitAutoDetect })} />
            <TextRow label="作者名" value={settings.gitAuthor} onChange={(gitAuthor) => patchSettings({ gitAuthor })} />
            <TextRow label="邮箱" value={settings.gitEmail} onChange={(gitEmail) => patchSettings({ gitEmail })} />
          </SettingCard>
        </PanelGrid>
      )
    case '环境':
      return (
        <ListEditor
          title="环境变量"
          items={settings.envVars}
          columns={['变量名', '值']}
          onAdd={() => patchSettings({ envVars: [...settings.envVars, { id: crypto.randomUUID(), key: 'NEW_KEY', value: '' }] })}
          onDelete={(index) => patchSettings({ envVars: settings.envVars.filter((_, i) => i !== index) })}
          render={(item, index) => (
            <>
              <InlineInput value={item.key} onChange={(key) => patchSettings({ envVars: replaceAt(settings.envVars, index, { ...item, key }) })} mono />
              <InlineInput value={item.value} onChange={(value) => patchSettings({ envVars: replaceAt(settings.envVars, index, { ...item, value }) })} mono password />
            </>
          )}
        />
      )
    case '工作树':
      return (
        <PanelGrid>
          <SettingCard title="隔离工作树" desc="为 Codex、Claude Code、OpenCode 等 CLI Agent 分配独立工作区。">
            <TextRow label="工作树根目录" value={settings.worktreeRoot} onChange={(worktreeRoot) => patchSettings({ worktreeRoot })} mono />
            <ToggleRow label="每个 Agent 使用独立 worktree" checked={settings.isolateWorktrees} onChange={(isolateWorktrees) => patchSettings({ isolateWorktrees })} />
          </SettingCard>
        </PanelGrid>
      )
    case '浏览器':
      return (
        <PanelGrid>
          <SettingCard title="浏览器预览" desc="配置 Agent 打开网页、截图和验证 UI 时使用的浏览器环境。">
            <SelectRow label="浏览器" value={settings.browserProvider} options={['内置浏览器', '系统 Chrome', '系统 Edge']} onChange={(browserProvider) => patchSettings({ browserProvider })} />
            <SelectRow label="默认视口" value={settings.browserViewport} options={['1280x720', '1440x900', '390x844']} onChange={(browserViewport) => patchSettings({ browserViewport })} />
          </SettingCard>
        </PanelGrid>
      )
    case '电脑操控':
      return (
        <PanelGrid>
          <SettingCard title="电脑操控权限" desc="控制 Agent 是否可以操作桌面、浏览器和本地应用。">
            <ToggleRow label="允许电脑操控" checked={settings.computerControl} onChange={(computerControl) => patchSettings({ computerControl })} />
            <ToggleRow label="敏感操作需要确认" checked={settings.requireApproval} onChange={(requireApproval) => patchSettings({ requireApproval })} />
          </SettingCard>
        </PanelGrid>
      )
    case '已归档对话':
      return (
        <PanelGrid>
          <SettingCard title="归档策略" desc="管理历史会话保留时间和恢复策略。">
            <SelectRow label="归档保留" value={settings.archivedRetention} options={['30 天', '90 天', '180 天', '永久']} onChange={(archivedRetention) => patchSettings({ archivedRetention })} />
            <div className="rounded-xl border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-400">暂无已归档对话</div>
          </SettingCard>
        </PanelGrid>
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
  const configuredCount = models.filter((item) => item.apiKey || item.apiKeyEnv).length
  const enabledCount = models.filter((item) => item.enabled).length
  const testedCount = models.filter((item) => item.tested).length

  return (
    <div>
      <div className="mb-6 flex justify-end">
        <button type="button" onClick={openCreate} className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700">
          <Plus className="h-4 w-4" />
          添加模型
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
              <th className="w-20 px-4 py-3">启用</th>
              <th className="px-4 py-3">名称</th>
              <th className="px-4 py-3">提供商</th>
              <th className="px-4 py-3">模型 ID</th>
              <th className="px-4 py-3">API 端点</th>
              <th className="px-4 py-3">API Key</th>
              <th className="px-4 py-3">连接</th>
              <th className="px-4 py-3">操作</th>
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
                  <div className="font-mono text-xs text-neutral-600">{item.apiKeyEnv || '自动生成'}</div>
                  {(item.apiKey || item.apiKeyEnv) && <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">已设置</span>}
                </td>
                <td className="px-4 py-3">
                  <button type="button" onClick={() => testModel(item)} disabled={testingId === item.id} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
                    {testingId === item.id ? '测试中' : '测试'}
                  </button>
                  {testMessages[item.id] && (
                    <div className={cn('mt-1 max-w-[160px] truncate text-xs', item.tested ? 'text-emerald-600' : 'text-red-500')} title={testMessages[item.id]}>
                      {testMessages[item.id]}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3 text-xs">
                    <button type="button" onClick={() => openEdit(item)} className="text-sky-600 hover:underline">编辑</button>
                    <button type="button" onClick={() => deleteModel(item.id)} className="text-red-500 hover:underline">删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-neutral-400">
        提示：模型变更会自动保存并同步到聊天后端。当前是本地单用户 Demo 模式，API Key 会保存在本机 SQLite settings 中；不同 API 协议的 CLI 工具配置在“Code Agent”页面管理。
      </p>
    </div>
  )
}

function AutoSaveStatus({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
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
      {label}
    </div>
  )
}

function PanelGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 xl:grid-cols-2">{children}</div>
}

function SettingCard({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-neutral-500">{desc}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-neutral-700">{label}</span>
      <SmallToggle checked={checked} onChange={onChange} />
    </div>
  )
}

function SmallToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className={cn('relative h-6 w-10 rounded-full transition', checked ? 'bg-neutral-950' : 'bg-neutral-300')}>
      <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white transition', checked ? 'left-5' : 'left-1')} />
    </button>
  )
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-neutral-700">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-neutral-400">
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  )
}

function TextRow({ label, value, onChange, mono = false }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-neutral-700">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} className={cn('settings-input', mono && 'font-mono')} />
    </label>
  )
}

function ListEditor<T>({
  title,
  items,
  columns,
  onAdd,
  onDelete,
  render,
}: {
  title: string
  items: T[]
  columns: string[]
  onAdd: () => void
  onDelete: (index: number) => void
  render: (item: T, index: number) => React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" onClick={onAdd} className="inline-flex h-8 items-center gap-2 rounded-lg bg-neutral-950 px-3 text-sm text-white hover:bg-neutral-800"><Plus className="h-4 w-4" />添加</button>
      </div>
      <div className="grid gap-3 px-5 py-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr)) 40px` }}>
        {columns.map((column) => <div key={column} className="text-xs font-medium text-neutral-400">{column}</div>)}
        <div />
        {items.map((item, index) => (
          <div key={index} className="contents">
            {render(item, index)}
            <button type="button" onClick={() => onDelete(index)} className="grid h-9 w-9 place-items-center rounded-lg text-neutral-400 hover:bg-red-50 hover:text-red-500">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function InlineInput({ value, onChange, mono = false, password = false }: { value: string; onChange: (value: string) => void; mono?: boolean; password?: boolean }) {
  return <input type={password ? 'password' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} className={cn('h-9 min-w-0 rounded-lg border border-neutral-200 px-2 text-sm outline-none focus:border-neutral-400', mono && 'font-mono text-xs')} />
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 border-r border-neutral-200 px-4 py-3 last:border-r-0">
      <span className="text-xl font-medium text-neutral-900">{value}</span>
      <span className="text-xs text-neutral-500">{label}</span>
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
  const patch = (value: Partial<ModelConfig>) => setDraft({ ...draft, ...value })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6">
      <div className="w-full max-w-4xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editing ? '编辑模型' : '添加模型'}</h2>
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
          启用此模型
        </label>

        <div className="mt-7 flex justify-end gap-3">
          <button onClick={onClose} className="h-9 rounded-lg border border-neutral-200 px-4 text-sm text-neutral-700 hover:bg-neutral-50">取消</button>
          <button onClick={onSave} className="h-9 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-700">{editing ? '保存' : '添加'}</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', wide = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; wide?: boolean }) {
  if (label.toLowerCase().includes('api key')) type = 'password'
  return (
    <label className={cn('block', wide && 'md:col-span-2')}>
      <span className="mb-1.5 block text-xs font-medium text-neutral-500">{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="settings-input font-mono" placeholder={placeholder} />
    </label>
  )
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return items.map((current, i) => (i === index ? item : current))
}

function sectionDescription(section: SectionKey) {
  const descriptions: Record<SectionKey, string> = {
    常规: '配置启动行为、语言、保存策略和基础交互习惯。',
    外观: '调整主题、强调色、字体尺寸和聊天阅读密度。',
    配置: '管理可用模型、API 端点、密钥变量和连接测试状态。',
    个性化: '定义默认 Agent 的语气、回答深度和行动策略。',
    键盘快捷键: '管理高频操作快捷键，提升聊天和编程效率。',
    'MCP 服务器': '配置可被 Agent 调用的 MCP 工具服务器。',
    钩子: '在消息、工具调用和任务完成前后执行自动化命令。',
    连接: '管理 GitHub、Vercel 等外部服务连接。',
    Git: '配置提交作者、仓库检测和 Git 工作流偏好。',
    环境: '管理本地环境变量，供模型、CLI 和部署流程使用。',
    工作树: '配置多 Agent 并行任务的 worktree 隔离策略。',
    浏览器: '设置预览、截图和 UI 验证使用的浏览器环境。',
    电脑操控: '控制 Agent 操作本机应用、浏览器和桌面的权限边界。',
    已归档对话: '管理归档会话的保留、恢复和清理策略。',
  }
  return descriptions[section]
}
