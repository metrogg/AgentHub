import { env } from '../env'

export type StudioStatus = '在线' | '草稿' | '运行中' | '等待中' | '成功' | '失败' | '需要授权' | '只读'

export type StudioModuleKey =
  | 'agents'
  | 'agent-clusters'
  | 'prompts'
  | 'workflows'
  | 'processors'
  | 'mcps'
  | 'tools'
  | 'workspaces'
  | 'request-context'
  | 'memory'
  | 'agent-builder'
  | 'vectors'
  | 'embedders'
  | 'tool-providers'
  | 'processor-providers'
  | 'evaluation'
  | 'scorers'
  | 'datasets'
  | 'experiments'
  | 'metrics'
  | 'observability'
  | 'logs'
  | 'background-tasks'
  | 'schedules'
  | 'settings'
  | 'resources'

export interface StudioRow {
  id: string
  name: string
  scope: string
  metric: string
  status: StudioStatus | string
  kind: string
  updatedAt: string
  description: string
  tags: string[]
}

export interface StudioKpi {
  label: string
  value: string
  delta: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
}

export interface StudioModule {
  key: StudioModuleKey
  title: string
  eyebrow: string
  description: string
  action: string
  docsHref?: string
  columns: [string, string, string, string]
  capabilities: string[]
  kpis: StudioKpi[]
  rows: StudioRow[]
}

export interface StudioEvent {
  id: string
  moduleKey: StudioModuleKey
  action: string
  summary: string
  status: 'success' | 'queued' | 'failed'
  createdAt: string
  payload?: unknown
}

export interface StudioTrace {
  id: string
  span: string
  status: string
  latency: string
  input: string
  output: string
  tokens: number
  startedAt: string
}

export interface StudioReviewItem {
  id: string
  title: string
  status: '通过' | '待确认' | '退回'
  reviewer: string
  note: string
}

export interface StudioEvaluationResult {
  id: string
  dataset: string
  scorer: string
  score: number
  status: '通过' | '关注' | '失败'
  createdAt: string
  summary: string
}

export interface StudioAgent {
  id: string
  name: string
  model: string
  provider: string
  temperature: number
  maxSteps: number
  memoryEnabled: boolean
  tracingEnabled: boolean
  prompt: string
  tools: string[]
  workflows: string[]
  processors: string[]
  scorers: string[]
  datasets: string[]
  memoryThreads: Array<{ id: string; title: string; messages: number; updatedAt: string }>
  traces: StudioTrace[]
  reviews: StudioReviewItem[]
  evaluations: StudioEvaluationResult[]
}

export type StudioClusterTopology = 'supervisor' | 'pipeline' | 'committee' | 'swarm'

export interface StudioClusterMember {
  agentId: string
  name: string
  role: string
  model: string
  status: StudioStatus | string
  load: number
  tools: string[]
  handoffPolicy: string
}

export interface StudioClusterRoute {
  id: string
  from: string
  to: string
  condition: string
  mode: 'delegate' | 'parallel' | 'review' | 'fallback'
  status: StudioStatus | string
}

export interface StudioClusterRun {
  id: string
  title: string
  status: StudioStatus | string
  startedAt: string
  latency: string
  tokens: number
  owner: string
  route: string[]
  summary: string
}

export interface StudioAgentCluster {
  id: string
  name: string
  topology: StudioClusterTopology
  status: StudioStatus | string
  description: string
  supervisorId: string
  members: StudioClusterMember[]
  routes: StudioClusterRoute[]
  runs: StudioClusterRun[]
  policies: Array<{ label: string; value: string }>
}

const now = () => new Date().toISOString()

const docsBase = 'https://mastra.ai/en/docs'

const studioModules: Record<StudioModuleKey, StudioModule> = {
  agents: {
    key: 'agents',
    title: '智能体',
    eyebrow: 'Primitives',
    description: '对应 Mastra listAgents/getAgent：管理 Agent、模型、系统提示词、工具绑定、子 Agent、记忆和运行入口。',
    action: '新建智能体',
    docsHref: `${docsBase}/agents/overview`,
    columns: ['名称', '标识/范围', '配置/指标', '状态'],
    capabilities: ['发现智能体', '打开聊天运行台', '编辑提示词与模型', '查看记忆、评估和追踪'],
    kpis: [
      { label: '已注册', value: '3', delta: '+1 本地', tone: 'success' },
      { label: '可运行', value: '2', delta: '1 个草稿', tone: 'neutral' },
      { label: '平均延迟', value: '1.8s', delta: '-0.3s', tone: 'success' },
    ],
    rows: [
      row('weather-agent', 'Weather Agent', 'weather-agent', 'claude-sonnet-4-6', '在线', 'agent', '天气查询智能体，带工具调用、记忆和评估。', ['memory', 'tools']),
      row('research-agent', 'Research Agent', 'research-agent', 'claude-haiku-4-5', '草稿', 'agent', '用于资料检索与摘要生成的候选智能体。', ['draft']),
      row('builder-agent', 'Builder Agent', 'builder-agent', 'claude-sonnet-4-6', '等待中', 'agent', '面向项目搭建与代码任务拆解。', ['workflow']),
    ],
  },
  'agent-clusters': {
    key: 'agent-clusters',
    title: 'Agent 集群',
    eyebrow: 'Primitives',
    description: '对应 Mastra Agent Network：管理 routing agent、sub-agents、路由策略、共享记忆、HITL 和集群运行入口。',
    action: '新建集群',
    docsHref: `${docsBase}/agents/agent-network`,
    columns: ['集群', '拓扑/范围', '成员/指标', '状态'],
    capabilities: ['集群列表', 'Routing Agent 调度', 'Sub-agent 交接', '共享记忆与线程', '运行流事件', 'HITL 暂停/恢复'],
    kpis: [
      { label: '集群', value: '3', delta: '2 可运行', tone: 'success' },
      { label: '成员 Agent', value: '10', delta: '+4', tone: 'neutral' },
      { label: '路由成功率', value: '94%', delta: '+5%', tone: 'success' },
    ],
    rows: [
      row('agenthub-delivery-network', 'AgentHub Delivery Network', 'supervisor', '4 agents / 6 routes', '在线', 'agent-network', '由 Builder 作为 routing agent，串联研究、实现、审查和发布守门。', ['network', 'supervisor', 'hitl']),
      row('weather-ops-network', 'Weather Ops Network', 'pipeline', '3 agents / 4 routes', '运行中', 'agent-network', '天气查询、工具守卫、评估器组成的稳定运行管线。', ['weather', 'evaluation']),
      row('review-committee-network', 'Review Committee Network', 'committee', '3 agents / 3 routes', '草稿', 'agent-network', '多评审 Agent 并行投票，输出风险、质量和上线建议。', ['review', 'parallel']),
    ],
  },
  prompts: {
    key: 'prompts',
    title: '提示词',
    eyebrow: 'Primitives',
    description: '对应 Stored Prompt Blocks：维护可复用 Prompt block、变量、版本、发布状态和回滚入口。',
    action: '新建提示词',
    docsHref: `${docsBase}/agents/agent-instructions#prompt-blocks`,
    columns: ['名称', '类型/范围', '版本/变量', '状态'],
    capabilities: ['提示词版本管理', '变量模板', '发布/回滚', '绑定到 Agent'],
    kpis: [
      { label: 'Prompt Blocks', value: '3', delta: '2 已发布', tone: 'success' },
      { label: '变量', value: '10', delta: '+4', tone: 'neutral' },
      { label: '待审', value: '1', delta: '需要确认', tone: 'warning' },
    ],
    rows: [
      row('weather-system', 'weather-system', '系统提示词', 'v7 / 3 变量', '成功', 'prompt', '天气智能体的系统提示词模板。', ['published']),
      row('handoff-template', 'handoff-template', '任务交接', 'v2 / 4 变量', '草稿', 'prompt', '多 Agent 交接时的上下文模板。', ['handoff']),
      row('review-rubric', 'review-rubric', '审查标准', 'v4 / 6 规则', '成功', 'prompt', '评估与人工审查共用的 rubric。', ['review']),
    ],
  },
  workflows: {
    key: 'workflows',
    title: '工作流',
    eyebrow: 'Primitives',
    description: '对应 listWorkflows/getWorkflow：运行、恢复、重启、回放确定性的多步骤工作流。',
    action: '创建运行',
    docsHref: `${docsBase}/workflows/overview`,
    columns: ['名称', '步骤/范围', '最近结果', '状态'],
    capabilities: ['触发工作流', '查看步骤图', '暂停/恢复', '运行历史与调度'],
    kpis: [
      { label: '工作流', value: '3', delta: '1 运行中', tone: 'neutral' },
      { label: '成功率', value: '91%', delta: '+6%', tone: 'success' },
      { label: '排队', value: '1', delta: '等待审批', tone: 'warning' },
    ],
    rows: [
      row('lessComplexWorkflow', 'lessComplexWorkflow', '4 steps', '1.8s', '成功', 'workflow', '基础串行工作流，用于验证运行状态与步骤输出。', ['run']),
      row('agentHandoffWorkflow', 'agentHandoffWorkflow', '6 steps', '12.4s', '等待中', 'workflow', '多 Agent 任务交接与人工审批示例。', ['handoff', 'approval']),
      row('datasetEvalWorkflow', 'datasetEvalWorkflow', '5 steps', '-', '在线', 'workflow', '批量评估数据集并写入实验结果。', ['evaluation']),
    ],
  },
  processors: {
    key: 'processors',
    title: '处理器',
    eyebrow: 'Primitives',
    description: '对应 listProcessors/getProcessor：配置输入、输出、安全、审查和工具调用处理器。',
    action: '添加处理器',
    docsHref: `${docsBase}/agents/processors`,
    columns: ['名称', '阶段/范围', '优先级/策略', '状态'],
    capabilities: ['输入处理', '输出处理', '工具调用守卫', '安全审查'],
    kpis: [
      { label: '处理器', value: '3', delta: '全部启用', tone: 'success' },
      { label: '阻断', value: '2', delta: '24h', tone: 'warning' },
      { label: 'P95', value: '22ms', delta: '稳定', tone: 'success' },
    ],
    rows: [
      row('pii-redactor', 'pii-redactor', '输入处理', '高优先级', '在线', 'processor', '进入模型前脱敏邮箱、手机号等敏感字段。', ['safety']),
      row('markdown-normalizer', 'markdown-normalizer', '输出处理', '默认', '在线', 'processor', '规范化 Markdown 输出，清理空段落。', ['output']),
      row('tool-guard', 'tool-guard', '工具调用', '需要审批', '在线', 'processor', '对文件写入、命令执行等高风险工具加审批。', ['approval']),
    ],
  },
  mcps: {
    key: 'mcps',
    title: 'MCP 服务',
    eyebrow: 'Primitives',
    description: '对应 MCP Server APIs：连接外部 MCP Server，查看工具、资源、授权和健康状态。',
    action: '连接服务',
    docsHref: `${docsBase}/tools-mcp/mcp-overview`,
    columns: ['名称', '传输/范围', '工具/资源', '状态'],
    capabilities: ['服务列表', '工具发现', '资源浏览', '授权状态'],
    kpis: [
      { label: '服务', value: '3', delta: '2 已连接', tone: 'success' },
      { label: '工具', value: '25', delta: '+5', tone: 'neutral' },
      { label: '授权', value: '1', delta: '待处理', tone: 'warning' },
    ],
    rows: [
      row('filesystem', 'filesystem', 'stdio', '8 tools', '在线', 'mcp', '本地文件系统 MCP，提供读写和检索能力。', ['local']),
      row('browser', 'browser', 'local', '5 tools', '在线', 'mcp', '浏览器自动化 MCP，用于页面验证。', ['browser']),
      row('github', 'github', 'oauth', '12 tools', '需要授权', 'mcp', 'GitHub 资源与 Pull Request 集成。', ['oauth']),
    ],
  },
  tools: {
    key: 'tools',
    title: '工具',
    eyebrow: 'Primitives',
    description: '对应 listTools/getTool：查看工具 schema、权限策略、执行记录、失败原因和审批策略。',
    action: '注册工具',
    docsHref: `${docsBase}/agents/using-tools-and-mcp`,
    columns: ['名称', '用途/范围', '策略/指标', '状态'],
    capabilities: ['Schema 预览', '执行测试', '审批策略', '失败诊断'],
    kpis: [
      { label: '工具', value: '5', delta: '3 本地', tone: 'neutral' },
      { label: '运行', value: '55', delta: '24h', tone: 'success' },
      { label: '需要审批', value: '2', delta: '高风险', tone: 'warning' },
    ],
    rows: [
      row('weatherInfo', 'weatherInfo', '查询天气', '安全 / 32 runs', '在线', 'tool', '调用天气数据源并返回温度、湿度、风力与降水。', ['safe']),
      row('simpleMcpTool', 'simpleMcpTool', 'MCP 调用', '需审批 / 9 runs', '需要授权', 'tool', '演示 MCP 工具代理调用。', ['mcp']),
      row('workspace.patch', 'workspace.patch', '修改文件', '需审批 / 14 runs', '需要授权', 'tool', '对工作区文件执行补丁写入。', ['workspace']),
    ],
  },
  workspaces: {
    key: 'workspaces',
    title: '工作区',
    eyebrow: 'Primitives',
    description: '对应 Workspace APIs：组织项目、包、运行时环境、本地资源和 Mastra 参考源码。',
    action: '新建工作区',
    docsHref: `${docsBase}/workspace/overview`,
    columns: ['名称', '路径/范围', '类型/指标', '状态'],
    capabilities: ['工作区列表', '技能/文件浏览', '参考源码迁移', '本地运行状态'],
    kpis: [
      { label: '本地工作区', value: '2', delta: '1 可写', tone: 'success' },
      { label: '参考源', value: 'Mastra', delta: '只读', tone: 'neutral' },
      { label: '可迁移文件', value: '240+', delta: '文本文件', tone: 'neutral' },
    ],
    rows: [
      row('agenthub', 'AgentHub', env.AGENTHUB_WORKSPACE_ROOT, '本地项目', '在线', 'workspace', '当前 AgentHub 应用工作区。', ['writable']),
      row('mastra-main', 'Mastra Reference', env.MASTRA_REFERENCE_ROOT, '参考源码', '只读', 'workspace', 'Mastra 源码参考，用于功能迁移和 UI 对照。', ['readonly']),
      row('experiments', 'Experiments', 'workspace/tmp', '沙箱', '等待中', 'workspace', '实验运行、数据集生成和临时产物。', ['sandbox']),
    ],
  },
  'request-context': {
    key: 'request-context',
    title: '请求上下文',
    eyebrow: 'Primitives',
    description: '对应 Request Context：调试运行时上下文、用户变量、租户信息、追踪标签和运行参数。',
    action: '保存上下文',
    docsHref: `${docsBase}/agents/request-context`,
    columns: ['键', '值/范围', '类型/来源', '状态'],
    capabilities: ['上下文变量', '租户调试', '追踪标签', '运行时覆盖'],
    kpis: [
      { label: '变量', value: '4', delta: '全局/会话', tone: 'neutral' },
      { label: '采样', value: '100%', delta: '本地', tone: 'success' },
      { label: '租户', value: 'local-dev', delta: '默认', tone: 'neutral' },
    ],
    rows: [
      row('user.locale', 'user.locale', 'zh-CN', 'string / 全局', '在线', 'context', '当前 UI 与 Agent 输出语言。', ['locale']),
      row('tenant.id', 'tenant.id', 'local-dev', 'string / 会话', '在线', 'context', '本地开发租户标识。', ['tenant']),
      row('trace.sampled', 'trace.sampled', 'true', 'boolean / 运行', '在线', 'context', '是否强制采样当前运行。', ['trace']),
    ],
  },
  memory: {
    key: 'memory',
    title: '记忆',
    eyebrow: 'Runtime',
    description: '对应 Memory Threads/Working Memory/Observational Memory：管理线程、工作记忆和观测记忆状态。',
    action: '新建记忆线程',
    docsHref: `${docsBase}/memory/overview`,
    columns: ['线程', '归属/范围', '消息/状态', '状态'],
    capabilities: ['线程列表', '消息读取', '工作记忆更新', '观测记忆缓冲状态'],
    kpis: [
      { label: '线程', value: '2', delta: '+1 今日', tone: 'success' },
      { label: '消息', value: '18', delta: '可检索', tone: 'neutral' },
      { label: '缓冲', value: '0', delta: '已同步', tone: 'success' },
    ],
    rows: [
      row('thread-weather-001', '天气查询线程', 'weather-agent', '12 messages', '在线', 'memory', '上海天气查询上下文。', ['thread']),
      row('working-memory-weather', '工作记忆', 'weather-agent', '3 keys', '在线', 'memory', '用户偏好和常用城市。', ['working-memory']),
      row('observational-memory', '观测记忆', 'resource:user-local', 'buffer empty', '成功', 'memory', '运行后沉淀的用户事实。', ['observational']),
    ],
  },
  'agent-builder': {
    key: 'agent-builder',
    title: 'Agent Builder',
    eyebrow: 'Runtime',
    description: '对应 Agent Builder Actions 和 registry：从模板、注册表和工作流生成新的 Agent。',
    action: '运行构建器',
    docsHref: `${docsBase}/agent-builder/overview`,
    columns: ['动作', '来源/范围', '模板/指标', '状态'],
    capabilities: ['构建动作列表', '模板预览', '注册表搜索', '安装到工作区'],
    kpis: [
      { label: '动作', value: '3', delta: '可运行', tone: 'success' },
      { label: '模板', value: '8', delta: '本地缓存', tone: 'neutral' },
      { label: '安装', value: '0', delta: '等待选择', tone: 'neutral' },
    ],
    rows: [
      row('builder.weather-agent', 'weather-agent-template', 'registry', 'Agent + Tool', '在线', 'builder', '从天气 Agent 模板生成配置。', ['template']),
      row('builder.research-agent', 'research-agent-template', 'registry', 'Agent + MCP', '草稿', 'builder', '研究型智能体模板。', ['template']),
      row('builder.workflow-agent', 'workflow-agent-template', 'local', 'Agent + Workflow', '在线', 'builder', '带工作流的 Agent 脚手架。', ['workflow']),
    ],
  },
  vectors: {
    key: 'vectors',
    title: '向量库',
    eyebrow: 'Runtime',
    description: '对应 listVectors/getVector：查看向量存储、索引维度、集合状态和连接信息。',
    action: '连接向量库',
    docsHref: `${docsBase}/rag/vector-databases`,
    columns: ['名称', '后端/范围', '维度/集合', '状态'],
    capabilities: ['向量库发现', '索引元数据', '集合状态', '检索测试'],
    kpis: [
      { label: '向量库', value: '2', delta: '1 本地', tone: 'neutral' },
      { label: '集合', value: '4', delta: '可检索', tone: 'success' },
      { label: '维度', value: '1536', delta: '默认', tone: 'neutral' },
    ],
    rows: [
      row('local-memory-vector', 'local-memory-vector', 'LibSQL', '1536 / 2 collections', '在线', 'vector', '本地记忆与文档检索向量库。', ['local']),
      row('eval-vector', 'eval-vector', 'Memory', '768 / 1 collection', '等待中', 'vector', '评估样本聚类用临时向量库。', ['eval']),
    ],
  },
  embedders: {
    key: 'embedders',
    title: '嵌入模型',
    eyebrow: 'Runtime',
    description: '对应 listEmbedders：查看可用 embedding provider、模型、维度和调用状态。',
    action: '添加嵌入模型',
    docsHref: `${docsBase}/rag/embeddings`,
    columns: ['名称', '供应商/范围', '模型/维度', '状态'],
    capabilities: ['模型列表', '维度检查', '供应商配置', '调用测试'],
    kpis: [
      { label: '模型', value: '2', delta: '1 默认', tone: 'neutral' },
      { label: '调用', value: '18', delta: '24h', tone: 'success' },
      { label: '失败', value: '0', delta: '稳定', tone: 'success' },
    ],
    rows: [
      row('text-embedding-3-small', 'text-embedding-3-small', 'OpenAI', '1536', '在线', 'embedder', '默认文本向量化模型。', ['default']),
      row('local-minilm', 'local-minilm', 'Local', '384', '等待中', 'embedder', '本地轻量嵌入模型占位。', ['local']),
    ],
  },
  'tool-providers': {
    key: 'tool-providers',
    title: '工具供应商',
    eyebrow: 'Runtime',
    description: '对应 listToolProviders/getToolProvider：管理第三方工具包、安装状态和工具发现。',
    action: '安装供应商',
    docsHref: `${docsBase}/tools-mcp/overview`,
    columns: ['供应商', '来源/范围', '工具数量', '状态'],
    capabilities: ['供应商列表', '工具包预览', '安装/卸载', '版本检查'],
    kpis: [
      { label: '供应商', value: '3', delta: '2 可用', tone: 'success' },
      { label: '工具包', value: '7', delta: '缓存', tone: 'neutral' },
      { label: '更新', value: '1', delta: '可升级', tone: 'warning' },
    ],
    rows: [
      row('filesystem-provider', 'filesystem-provider', 'built-in', '8 tools', '在线', 'provider', '文件系统工具供应商。', ['builtin']),
      row('browser-provider', 'browser-provider', 'plugin', '5 tools', '在线', 'provider', '浏览器验证工具供应商。', ['browser']),
      row('github-provider', 'github-provider', 'registry', '12 tools', '需要授权', 'provider', 'GitHub 工具供应商。', ['oauth']),
    ],
  },
  'processor-providers': {
    key: 'processor-providers',
    title: '处理器供应商',
    eyebrow: 'Runtime',
    description: '对应 getProcessorProviders/getProcessorProvider：管理处理器包、规则集和默认启用策略。',
    action: '安装处理器包',
    docsHref: `${docsBase}/agents/processors`,
    columns: ['供应商', '来源/范围', '处理器数量', '状态'],
    capabilities: ['供应商列表', '处理器模板', '默认策略', '版本检查'],
    kpis: [
      { label: '供应商', value: '2', delta: '本地', tone: 'neutral' },
      { label: '规则', value: '12', delta: '可复用', tone: 'success' },
      { label: '启用', value: '3', delta: '生产路径', tone: 'success' },
    ],
    rows: [
      row('safety-provider', 'safety-provider', 'built-in', '5 processors', '在线', 'provider', '安全与合规处理器包。', ['safety']),
      row('format-provider', 'format-provider', 'local', '7 processors', '在线', 'provider', '格式化与规范化处理器包。', ['format']),
    ],
  },
  evaluation: {
    key: 'evaluation',
    title: '评估概览',
    eyebrow: 'Evaluation',
    description: '对应 scores、datasets、experiments：汇总评分器、数据集、实验结果和回归趋势。',
    action: '运行评估',
    docsHref: `${docsBase}/evals/overview`,
    columns: ['指标', '范围/数据集', '变化/得分', '状态'],
    capabilities: ['批量评估', '分数聚合', '实验对比', '失败聚类'],
    kpis: [
      { label: '任务完成度', value: '92%', delta: '+4%', tone: 'success' },
      { label: '工具正确率', value: '88%', delta: '-2%', tone: 'warning' },
      { label: '安全性', value: '100%', delta: '稳定', tone: 'success' },
    ],
    rows: [
      row('task-completion', '任务完成度', 'weather-basic', '92% / +4%', '成功', 'score', '是否完整回答用户目标。', ['aggregate']),
      row('tool-validity', '工具正确率', 'tool-edge-cases', '88% / -2%', '等待中', 'score', '工具调用入参和返回是否符合预期。', ['tool']),
      row('conciseness', '回答简洁度', 'weather-basic', '95% / +1%', '成功', 'score', '控制回答长度与信息密度。', ['quality']),
    ],
  },
  scorers: {
    key: 'scorers',
    title: '评分器',
    eyebrow: 'Evaluation',
    description: '对应 listScorers/getScorer/saveScore：管理 LLM-as-judge、规则评分器、人工审查标准。',
    action: '新建评分器',
    docsHref: `${docsBase}/evals/overview`,
    columns: ['名称', '类型/范围', '量纲/指标', '状态'],
    capabilities: ['评分器列表', '单项评分', '分数保存', '聚合统计'],
    kpis: [
      { label: '评分器', value: '3', delta: '2 启用', tone: 'success' },
      { label: '评分', value: '126', delta: '7d', tone: 'neutral' },
      { label: '平均分', value: '0.93', delta: '+0.03', tone: 'success' },
    ],
    rows: [
      row('answer-relevance', 'answer-relevance', 'LLM Judge', '0-1', '在线', 'scorer', '回答相关性评分器。', ['judge']),
      row('tool-call-validity', 'tool-call-validity', '规则', 'pass/fail', '在线', 'scorer', '工具调用有效性规则。', ['rule']),
      row('safety-check', 'safety-check', '规则', 'pass/fail', '草稿', 'scorer', '安全性检查规则。', ['safety']),
    ],
  },
  datasets: {
    key: 'datasets',
    title: '数据集',
    eyebrow: 'Evaluation',
    description: '对应 Dataset APIs：维护测试样本、期望输出、版本、批量导入和合成数据生成。',
    action: '导入数据',
    docsHref: `${docsBase}/evals/datasets/overview`,
    columns: ['名称', '样本/范围', '版本/指标', '状态'],
    capabilities: ['样本列表', '版本历史', '批量导入/删除', 'AI 生成样本'],
    kpis: [
      { label: '数据集', value: '3', delta: '2 已发布', tone: 'success' },
      { label: '样本', value: '54', delta: '+8', tone: 'neutral' },
      { label: '版本', value: '6', delta: '可回放', tone: 'success' },
    ],
    rows: [
      row('weather-basic', 'weather-basic', '24 items', 'v3', '成功', 'dataset', '基础天气问答样本。', ['published']),
      row('handoff-cases', 'handoff-cases', '12 items', 'v1', '草稿', 'dataset', '多 Agent 交接样本。', ['draft']),
      row('tool-edge-cases', 'tool-edge-cases', '18 items', 'v2', '成功', 'dataset', '工具调用边界样本。', ['tools']),
    ],
  },
  experiments: {
    key: 'experiments',
    title: '实验',
    eyebrow: 'Evaluation',
    description: '对应 Experiments APIs：比较模型、提示词、工具组合在数据集上的表现，并支持结果审查。',
    action: '启动实验',
    docsHref: `${docsBase}/evals/datasets/running-experiments`,
    columns: ['名称', '数据集/范围', '进度/指标', '状态'],
    capabilities: ['触发实验', '结果列表', '对比实验', '审查状态汇总'],
    kpis: [
      { label: '实验', value: '3', delta: '1 运行中', tone: 'neutral' },
      { label: '最佳分', value: '91%', delta: '+5%', tone: 'success' },
      { label: '待审', value: '4', delta: '需要人工', tone: 'warning' },
    ],
    rows: [
      row('sonnet-vs-haiku', 'sonnet-vs-haiku', 'weather-basic', '64%', '运行中', 'experiment', '比较 Sonnet 与 Haiku 的天气问答表现。', ['ab']),
      row('prompt-v2-regression', 'prompt-v2-regression', 'handoff-cases', '91%', '成功', 'experiment', 'Prompt v2 回归测试。', ['regression']),
      row('tool-approval-ab', 'tool-approval-ab', 'tool-edge-cases', '0%', '等待中', 'experiment', '工具审批策略 A/B 测试。', ['approval']),
    ],
  },
  metrics: {
    key: 'metrics',
    title: '指标',
    eyebrow: 'Observability',
    description: '对应 metrics OLAP APIs：观察调用量、延迟、Token、成本、活跃线程和失败率。',
    action: '刷新指标',
    docsHref: `${docsBase}/observability/overview`,
    columns: ['指标', '范围/实体', '变化/数值', '窗口'],
    capabilities: ['聚合指标', '时间序列', '分位数', '标签维度发现'],
    kpis: [
      { label: 'Agent Runs', value: '128', delta: '+18%', tone: 'success' },
      { label: 'Total Tokens', value: '482k', delta: '+9%', tone: 'neutral' },
      { label: 'P95 Latency', value: '2.4s', delta: '-0.3s', tone: 'success' },
    ],
    rows: [
      row('agent-runs', 'Agent Runs', 'all agents', '128 / +18%', '成功', 'metric', '24 小时内 Agent 运行次数。', ['24h']),
      row('total-tokens', 'Total Tokens', 'all agents', '482k / +9%', '成功', 'metric', 'Token 使用量。', ['tokens']),
      row('p95-latency', 'P95 Latency', 'all agents', '2.4s / -0.3s', '成功', 'metric', 'P95 端到端延迟。', ['latency']),
    ],
  },
  observability: {
    key: 'observability',
    title: '追踪',
    eyebrow: 'Observability',
    description: '对应 listTraces/getTrace/getSpan：检查 Trace、Span、输入输出、Token 用量、评分和运行状态。',
    action: '打开 Trace',
    docsHref: `${docsBase}/observability/tracing/overview`,
    columns: ['Trace', '实体/范围', '耗时/指标', '状态'],
    capabilities: ['Trace 列表', 'Span 详情', '分支追踪', '评分与反馈'],
    kpis: [
      { label: 'Traces', value: '18', delta: '+5', tone: 'neutral' },
      { label: '成功率', value: '94%', delta: '+2%', tone: 'success' },
      { label: '最长耗时', value: '12.4s', delta: '工作流', tone: 'warning' },
    ],
    rows: [
      row('trace_weather_001', 'trace_weather_001', 'Weather Agent', '1.8s / 740 tokens', '成功', 'trace', '天气查询生成流程。', ['agent']),
      row('trace_tool_014', 'trace_tool_014', 'weatherInfo', '320ms / tool', '成功', 'trace', '天气工具调用 Span。', ['tool']),
      row('trace_workflow_008', 'trace_workflow_008', 'lessComplexWorkflow', '12.4s / waiting', '等待中', 'trace', '工作流多步骤运行。', ['workflow']),
    ],
  },
  logs: {
    key: 'logs',
    title: '日志',
    eyebrow: 'Observability',
    description: '对应 listLogs/log transports：按时间、级别、实体和 Trace 过滤运行时日志。',
    action: '导出日志',
    docsHref: `${docsBase}/observability/logging`,
    columns: ['时间', '级别/范围', '实体/信息', '状态'],
    capabilities: ['日志列表', '级别过滤', 'Trace 关联', '导出'],
    kpis: [
      { label: '日志', value: '86', delta: '24h', tone: 'neutral' },
      { label: '警告', value: '2', delta: '需要确认', tone: 'warning' },
      { label: '错误', value: '0', delta: '稳定', tone: 'success' },
    ],
    rows: [
      row('log-120122', '12:01:22', 'info', 'Weather Agent / stream completed', '成功', 'log', 'Weather Agent 完成流式回复。', ['info']),
      row('log-120048', '12:00:48', 'warn', 'tool-guard / approval required', '等待中', 'log', '工具守卫要求人工审批。', ['warn']),
      row('log-115803', '11:58:03', 'info', 'workflow / run created', '成功', 'log', '工作流运行创建。', ['workflow']),
    ],
  },
  'background-tasks': {
    key: 'background-tasks',
    title: '后台任务',
    eyebrow: 'Runtime',
    description: '对应 Background Tasks APIs：查看长任务、异步工具调用、实验运行和 SSE 事件流状态。',
    action: '刷新任务',
    docsHref: `${docsBase}/agents/background-tasks`,
    columns: ['任务', '归属/范围', '进度/指标', '状态'],
    capabilities: ['任务列表', '任务详情', '状态过滤', '事件流'],
    kpis: [
      { label: '任务', value: '4', delta: '1 运行中', tone: 'neutral' },
      { label: '完成', value: '3', delta: '24h', tone: 'success' },
      { label: '失败', value: '0', delta: '稳定', tone: 'success' },
    ],
    rows: [
      row('task-eval-001', 'dataset-eval-run', 'weather-agent', '72%', '运行中', 'task', '数据集评估后台任务。', ['evaluation']),
      row('task-index-002', 'workspace-index', 'AgentHub', '100%', '成功', 'task', '工作区索引完成。', ['workspace']),
      row('task-sync-003', 'mastra-reference-sync', 'Mastra Reference', '100%', '成功', 'task', '参考源扫描完成。', ['sync']),
    ],
  },
  schedules: {
    key: 'schedules',
    title: '调度',
    eyebrow: 'Runtime',
    description: '对应 Schedules APIs：列出工作流调度、触发历史，并支持暂停/恢复。',
    action: '新建调度',
    docsHref: `${docsBase}/workflows/schedules`,
    columns: ['调度', '工作流/范围', '下次触发/频率', '状态'],
    capabilities: ['调度列表', '触发历史', '暂停', '恢复'],
    kpis: [
      { label: '调度', value: '2', delta: '1 启用', tone: 'neutral' },
      { label: '触发', value: '12', delta: '7d', tone: 'success' },
      { label: '暂停', value: '1', delta: '手动', tone: 'warning' },
    ],
    rows: [
      row('schedule-weather-daily', 'weather-daily-eval', 'datasetEvalWorkflow', '每天 09:00', '在线', 'schedule', '每日天气数据集回归评估。', ['daily']),
      row('schedule-index-weekly', 'workspace-index-weekly', 'workspaceIndexWorkflow', '每周一', '等待中', 'schedule', '工作区每周索引。', ['weekly']),
    ],
  },
  settings: {
    key: 'settings',
    title: '设置',
    eyebrow: 'Studio',
    description: '对应 Builder Settings/System Packages/Infrastructure：管理模型供应商、API Key、运行时和实验开关。',
    action: '保存设置',
    docsHref: `${docsBase}/getting-started/studio`,
    columns: ['键', '值/范围', '类型/来源', '状态'],
    capabilities: ['模型供应商', '密钥状态', '基础设施健康', '系统包信息'],
    kpis: [
      { label: '模型', value: env.ANTHROPIC_MODEL, delta: '默认', tone: 'neutral' },
      { label: '密钥', value: env.ANTHROPIC_API_KEY ? '已配置' : '未配置', delta: env.ANTHROPIC_API_KEY ? '可运行' : '需要配置', tone: env.ANTHROPIC_API_KEY ? 'success' : 'warning' },
      { label: '运行时', value: 'Bun', delta: '本地', tone: 'success' },
    ],
    rows: [
      row('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY ? '已配置' : '未配置', 'secret', env.ANTHROPIC_API_KEY ? '在线' : '等待中', 'setting', 'Anthropic API Key 状态。', ['secret']),
      row('ANTHROPIC_MODEL', 'ANTHROPIC_MODEL', env.ANTHROPIC_MODEL, 'string', '在线', 'setting', '默认 Anthropic 模型。', ['model']),
      row('Studio theme', 'Studio theme', 'dark', 'enum', '在线', 'setting', '工作室主题。', ['ui']),
    ],
  },
  resources: {
    key: 'resources',
    title: '资源',
    eyebrow: 'Studio',
    description: '对应 Resources/System Packages：查看文档、运行时资源、模板和本地引用。',
    action: '打开资源',
    docsHref: `${docsBase}/getting-started/studio`,
    columns: ['资源', '路径/范围', '类型/来源', '状态'],
    capabilities: ['文档入口', '源码引用', '系统包', '模板资源'],
    kpis: [
      { label: '文档', value: '4', delta: '已挂载', tone: 'neutral' },
      { label: '源码', value: '2', delta: '本地', tone: 'success' },
      { label: '模板', value: '8', delta: '可用', tone: 'neutral' },
    ],
    rows: [
      row('mastra-studio-docs', 'Mastra Studio docs', 'https://mastra.ai', '文档', '在线', 'resource', 'Mastra Studio 官方文档入口。', ['docs']),
      row('agenthub-docs', 'AgentHub docs', 'docs/03-开发实现', '文档', '在线', 'resource', 'AgentHub 开发实现文档。', ['local']),
      row('mastra-main', 'mastra-main', env.MASTRA_REFERENCE_ROOT, '源码', '只读', 'resource', 'Mastra 参考源码。', ['source']),
    ],
  },
}

const agentStore: Record<string, StudioAgent> = {
  'weather-agent': {
    id: 'weather-agent',
    name: 'Weather Agent',
    model: env.ANTHROPIC_MODEL,
    provider: 'anthropic',
    temperature: 0.4,
    maxSteps: 4,
    memoryEnabled: true,
    tracingEnabled: true,
    prompt: [
      '你是一个可靠的天气助手，负责提供准确、简洁的天气信息。',
      '',
      '- 如果用户没有提供地点，先询问地点',
      '- 如果地点不是英文，可先翻译再查询',
      '- 回答中包含温度、湿度、风力和降水信息',
      '- 保持简洁，但不要遗漏关键事实',
    ].join('\n'),
    tools: ['weatherInfo', 'simpleMcpTool'],
    workflows: ['lessComplexWorkflow', 'datasetEvalWorkflow'],
    processors: ['pii-redactor', 'markdown-normalizer', 'tool-guard'],
    scorers: ['answer-relevance', 'tool-call-validity', 'safety-check'],
    datasets: ['weather-basic', 'tool-edge-cases'],
    memoryThreads: [
      { id: 'thread-weather-001', title: '上海天气查询', messages: 12, updatedAt: now() },
      { id: 'thread-weather-002', title: '北京周末天气', messages: 6, updatedAt: now() },
    ],
    traces: [
      trace('trace_weather_001', 'agent.generate', 'success', '1.8s', '上海明天天气', '已返回温度、湿度、风力和降水概率。', 740),
      trace('trace_tool_014', 'tool.weatherInfo', 'success', '320ms', 'location=Shanghai', 'weather payload normalized', 126),
      trace('trace_memory_004', 'memory.thread.load', 'success', '42ms', 'thread-weather-001', 'loaded 12 messages', 34),
    ],
    reviews: [
      review('review-location', '回答是否使用了正确地点', '通过', 'system', '地点识别为 Shanghai，符合输入。'),
      review('review-fields', '是否包含湿度、风况、降水', '通过', 'system', '回答包含完整天气字段。'),
      review('review-tone', '是否保持简洁', '通过', 'system', '输出长度适中。'),
      review('review-tool', '工具调用是否需要人工确认', '待确认', 'human', '涉及外部工具调用，保留人工审查入口。'),
    ],
    evaluations: [
      evaluation('eval-weather-001', 'weather-basic', 'answer-relevance', 0.92, '通过', '回答和天气问题高度相关。'),
      evaluation('eval-weather-002', 'tool-edge-cases', 'tool-call-validity', 0.88, '关注', '边界地点的工具入参还需要补齐。'),
      evaluation('eval-weather-003', 'weather-basic', 'safety-check', 1, '通过', '未发现安全问题。'),
    ],
  },
}

const clusterStore: Record<string, StudioAgentCluster> = {
  'agenthub-delivery-network': {
    id: 'agenthub-delivery-network',
    name: 'AgentHub Delivery Network',
    topology: 'supervisor',
    status: '在线',
    description: 'Builder 作为 routing agent，负责把需求拆成研究、实现、审查和发布四段式流转。',
    supervisorId: 'builder-agent',
    members: [
      clusterMember('builder-agent', 'Builder Agent', 'supervisor', env.ANTHROPIC_MODEL, '在线', 0.62, ['workflow', 'tool-guard'], '先规划后分派，复杂任务优先交给研究与实现并行处理。'),
      clusterMember('research-agent', 'Research Agent', 'research', 'claude-haiku-4-5', '运行中', 0.48, ['search', 'summarize'], '遇到未知信息时先检索并回填上下文。'),
      clusterMember('weather-agent', 'Weather Agent', 'executor', env.ANTHROPIC_MODEL, '运行中', 0.53, ['weatherInfo', 'simpleMcpTool'], '需要天气或外部工具时执行单次专门调用。'),
      clusterMember('review-agent', 'Review Agent', 'reviewer', 'gpt-5.4-mini', '等待中', 0.27, ['rubric', 'policy-check'], '输出前做质量、格式和安全审查。'),
    ],
    routes: [
      clusterRoute('route-plan', 'builder-agent', 'research-agent', '需求含未知事实或需要资料汇总', 'delegate', '在线'),
      clusterRoute('route-build', 'builder-agent', 'weather-agent', '检测到天气查询、工具调用或数据填充任务', 'parallel', '在线'),
      clusterRoute('route-review', 'research-agent', 'review-agent', '进入最终输出前进行审查', 'review', '在线'),
      clusterRoute('route-release', 'review-agent', 'builder-agent', '审查通过后回到 routing agent 汇总', 'fallback', '等待中'),
    ],
    runs: [
      clusterRun('network-run-014', '上海周末出行建议', '成功', '2026-05-19T01:02:00.000Z', '14.2s', 1682, 'builder-agent', ['builder-agent', 'research-agent', 'weather-agent', 'review-agent'], '已完成研究、天气查询与审查汇总。'),
      clusterRun('network-run-015', '工具故障回退分析', '运行中', '2026-05-19T01:18:00.000Z', '3.8s', 624, 'builder-agent', ['builder-agent', 'research-agent'], '正在等待审查 Agent 的结果回填。'),
    ],
    policies: [
      { label: '共享记忆', value: '开启' },
      { label: 'HITL', value: '审查节点可暂停' },
      { label: '最大跳数', value: '6' },
    ],
  },
  'weather-ops-network': {
    id: 'weather-ops-network',
    name: 'Weather Ops Network',
    topology: 'pipeline',
    status: '运行中',
    description: '天气类请求采用严格的线性管线，优先保证工具调用质量和输出稳定性。',
    supervisorId: 'weather-agent',
    members: [
      clusterMember('weather-agent', 'Weather Agent', 'executor', env.ANTHROPIC_MODEL, '运行中', 0.71, ['weatherInfo', 'simpleMcpTool'], '执行查询并生成简洁结果。'),
      clusterMember('tool-guard', 'Tool Guard', 'guard', 'rules-only', '在线', 0.23, ['approval', 'schema-check'], '高风险工具先审查再执行。'),
      clusterMember('answer-judge', 'Answer Judge', 'reviewer', 'gpt-5.4', '在线', 0.34, ['rubric', 'trace'], '评估输出是否覆盖温度、湿度和降水。'),
    ],
    routes: [
      clusterRoute('route-input', 'weather-agent', 'tool-guard', '检测到工具调用或外部数据源访问', 'delegate', '在线'),
      clusterRoute('route-judge', 'tool-guard', 'answer-judge', '结果生成后进入质量检查', 'review', '在线'),
      clusterRoute('route-fallback', 'answer-judge', 'weather-agent', '发现缺失字段或城市歧义', 'fallback', '运行中'),
    ],
    runs: [
      clusterRun('network-run-023', '北京周末天气', '成功', '2026-05-19T01:05:00.000Z', '9.6s', 944, 'weather-agent', ['weather-agent', 'tool-guard', 'answer-judge'], '天气查询与审查已完成。'),
      clusterRun('network-run-024', '杭州出行提醒', '运行中', '2026-05-19T01:21:00.000Z', '1.9s', 312, 'weather-agent', ['weather-agent', 'tool-guard'], '工具审批流程处理中。'),
    ],
    policies: [
      { label: '共享记忆', value: '按线程隔离' },
      { label: 'HITL', value: '高风险工具必审' },
      { label: '响应目标', value: '< 10s' },
    ],
  },
  'review-committee-network': {
    id: 'review-committee-network',
    name: 'Review Committee Network',
    topology: 'committee',
    status: '草稿',
    description: '多个 Agent 并行审查同一任务，再由汇总节点输出最终结论。',
    supervisorId: 'committee-router',
    members: [
      clusterMember('committee-router', 'Committee Router', 'router', 'gpt-5.4', '草稿', 0.22, ['dispatch', 'merge'], '并行分发任务给多个审查 Agent。'),
      clusterMember('quality-agent', 'Quality Agent', 'quality', 'claude-haiku-4-5', '等待中', 0.18, ['rubric'], '检查格式、完整性和事实一致性。'),
      clusterMember('safety-agent', 'Safety Agent', 'safety', 'gpt-5.4-mini', '等待中', 0.15, ['policy'], '检查高风险、越权与合规问题。'),
    ],
    routes: [
      clusterRoute('route-quality', 'committee-router', 'quality-agent', '需要质量审查', 'parallel', '等待中'),
      clusterRoute('route-safety', 'committee-router', 'safety-agent', '需要安全和合规审查', 'parallel', '等待中'),
      clusterRoute('route-merge', 'quality-agent', 'committee-router', '两个审查结果都返回后汇总', 'review', '等待中'),
    ],
    runs: [
      clusterRun('network-run-031', '发布前检查', '等待中', '2026-05-19T01:25:00.000Z', '0.0s', 0, 'committee-router', ['committee-router'], '等待把审查节点接入。'),
    ],
    policies: [
      { label: '并行审查', value: '开启' },
      { label: '回退阈值', value: '任一失败即回滚' },
      { label: '输出合并', value: '投票 + 汇总' },
    ],
  },
}

const studioEvents: StudioEvent[] = [
  event('agent-clusters', 'sync', '已同步 Agent Network/集群能力', 'success'),
  event('agents', 'sync', '已从 Mastra 功能边界同步智能体列表', 'success'),
  event('workspaces', 'index', '已索引 AgentHub 与 Mastra Reference 工作区', 'success'),
  event('evaluation', 'run', 'weather-basic 最近一次评估通过', 'success'),
]

export function listStudioModules() {
  return Object.values(studioModules).map(({ rows: _rows, ...module }) => module)
}

export function getStudioModule(key: string, query = '', status = '全部') {
  const moduleKey = normalizeModuleKey(key)
  const module = studioModules[moduleKey] ?? studioModules.agents
  const normalizedQuery = query.trim().toLowerCase()
  const rows = module.rows.filter((item) => {
    const text = [item.name, item.scope, item.metric, item.status, item.description, item.tags.join(' ')]
      .join(' ')
      .toLowerCase()
    const matchesQuery = normalizedQuery.length === 0 || text.includes(normalizedQuery)
    const matchesStatus = status === '全部' || item.status === status || item.tags.includes(status)
    return matchesQuery && matchesStatus
  })

  return { ...module, rows }
}

export function runStudioAction(key: string, action = 'run', payload?: unknown) {
  const moduleKey = normalizeModuleKey(key)
  const selectedId = payload && typeof payload === 'object' && 'selectedId' in payload ? String((payload as { selectedId?: unknown }).selectedId ?? '') : ''
  if (moduleKey === 'agent-clusters' && action === 'create') {
    const cluster = createAgentCluster(selectedId || undefined)
    return studioEvents.find((item) => item.payload && typeof item.payload === 'object' && (item.payload as { clusterId?: string }).clusterId === cluster.id) ?? studioEvents[0]!
  }
  if (moduleKey === 'agent-clusters' && action === 'run') {
    const run = runAgentCluster(selectedId || 'agenthub-delivery-network', payload)
    return studioEvents.find((item) => item.payload && typeof item.payload === 'object' && (item.payload as { runId?: string }).runId === run.id) ?? studioEvents[0]!
  }
  const module = studioModules[moduleKey] ?? studioModules.agents
  const summary = resolveActionSummary(module, action)
  const created = event(moduleKey, action, summary, action.includes('create') ? 'queued' : 'success', payload)
  studioEvents.unshift(created)
  studioEvents.splice(30)
  return created
}

export function listStudioEvents(limit = 12) {
  return studioEvents.slice(0, limit)
}

export function getStudioAgent(agentId: string) {
  if (agentStore[agentId]) return agentStore[agentId]
  const base = agentStore['weather-agent']!
  const created: StudioAgent = {
    ...base,
    id: agentId,
    name: humanizeId(agentId),
    memoryThreads: [],
    traces: [],
    reviews: [],
    evaluations: [],
  }
  agentStore[agentId] = created
  return created
}

export function updateStudioAgent(agentId: string, patch: Partial<StudioAgent>) {
  const current = getStudioAgent(agentId)
  const updated: StudioAgent = {
    ...current,
    ...patch,
    id: current.id,
    tools: Array.isArray(patch.tools) ? patch.tools : current.tools,
    workflows: Array.isArray(patch.workflows) ? patch.workflows : current.workflows,
    processors: Array.isArray(patch.processors) ? patch.processors : current.processors,
    scorers: Array.isArray(patch.scorers) ? patch.scorers : current.scorers,
    datasets: Array.isArray(patch.datasets) ? patch.datasets : current.datasets,
  }
  agentStore[agentId] = updated
  studioEvents.unshift(event('agents', 'save', `${updated.name} 配置已保存`, 'success', { agentId }))
  return updated
}

export function getAgentTabData(agentId: string, tab: string) {
  const agent = getStudioAgent(agentId)
  switch (tab) {
    case 'editor':
      return {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        model: agent.model,
        temperature: agent.temperature,
        maxSteps: agent.maxSteps,
        memoryEnabled: agent.memoryEnabled,
        tracingEnabled: agent.tracingEnabled,
        prompt: agent.prompt,
        tools: agent.tools,
        workflows: agent.workflows,
        processors: agent.processors,
        scorers: agent.scorers,
      }
    case 'evaluate':
      return {
        datasets: agent.datasets,
        scorers: agent.scorers,
        results: agent.evaluations,
      }
    case 'review':
      return { items: agent.reviews }
    case 'traces':
      return { traces: agent.traces }
    case 'memory':
      return { threads: agent.memoryThreads, enabled: agent.memoryEnabled }
    default:
      return agent
  }
}

export function runAgentEvaluation(agentId: string, dataset: string, scorer: string) {
  const agent = getStudioAgent(agentId)
  const score = scorer === 'safety-check' ? 1 : scorer === 'tool-call-validity' ? 0.89 : 0.93
  const status: StudioEvaluationResult['status'] = score >= 0.9 ? '通过' : '关注'
  const result = evaluation(
    `eval-${Date.now()}`,
    dataset,
    scorer,
    score,
    status,
    `${dataset} 使用 ${scorer} 完成一次本地评估。`,
  )
  agent.evaluations.unshift(result)
  studioEvents.unshift(event('evaluation', 'run-agent-evaluation', `${agent.name} 评估完成：${score.toFixed(2)}`, 'success', { agentId, dataset, scorer }))
  return result
}

export function updateReviewItem(agentId: string, reviewId: string, status: StudioReviewItem['status']) {
  const agent = getStudioAgent(agentId)
  agent.reviews = agent.reviews.map((item) => (item.id === reviewId ? { ...item, status, reviewer: 'human' } : item))
  studioEvents.unshift(event('agents', 'review', `${agent.name} 审查项已更新`, 'success', { agentId, reviewId, status }))
  return agent.reviews.find((item) => item.id === reviewId)
}

export function listAgentClusters() {
  return Object.values(clusterStore)
}

export function getAgentCluster(clusterId: string) {
  if (clusterStore[clusterId]) return clusterStore[clusterId]
  const base = clusterStore['agenthub-delivery-network']!
  const created: StudioAgentCluster = {
    ...base,
    id: clusterId,
    name: humanizeId(clusterId),
    status: '草稿',
    supervisorId: base.supervisorId,
    description: `${humanizeId(clusterId)} 的本地草稿集群。`,
    members: base.members.map((member) => ({ ...member, status: '等待中', load: Math.min(member.load, 0.2) })),
    routes: base.routes.map((route) => ({ ...route, status: '等待中' })),
    runs: [],
    policies: base.policies.map((item) => ({ ...item })),
  }
  return created
}

export function updateAgentCluster(clusterId: string, patch: Partial<StudioAgentCluster>) {
  const current = getAgentCluster(clusterId)
  const updated: StudioAgentCluster = {
    ...current,
    ...patch,
    id: current.id,
    members: Array.isArray(patch.members) ? patch.members : current.members,
    routes: Array.isArray(patch.routes) ? patch.routes : current.routes,
    runs: Array.isArray(patch.runs) ? patch.runs : current.runs,
    policies: Array.isArray(patch.policies) ? patch.policies : current.policies,
  }
  clusterStore[clusterId] = updated
  syncAgentClusterModuleRows()
  studioEvents.unshift(event('agent-clusters', 'save', `${updated.name} 配置已保存`, 'success', { clusterId }))
  return updated
}

export function createAgentCluster(seedId?: string) {
  const base = getAgentCluster(seedId ?? 'agenthub-delivery-network')
  const clusterId = `cluster-${Date.now()}`
  const created: StudioAgentCluster = {
    ...base,
    id: clusterId,
    name: `${base.name} 草稿`,
    status: '草稿',
    description: `${base.description}（草稿副本）`,
    members: base.members.map((member) => ({ ...member, status: '等待中', load: Math.max(0.12, Math.min(member.load, 0.36)) })),
    routes: base.routes.map((route) => ({ ...route, status: '等待中' })),
    runs: [],
  }
  clusterStore[clusterId] = created
  syncAgentClusterModuleRows()
  studioEvents.unshift(event('agent-clusters', 'create', `${created.name} 已创建为草稿`, 'queued', { clusterId, seedId: base.id }))
  return created
}

export function runAgentCluster(clusterId: string, input?: unknown) {
  const current = getAgentCluster(clusterId)
  const runId = `network-run-${Date.now()}`
  const route = current.routes.map((item) => item.to)
  const run = clusterRun(
    runId,
    current.name,
    current.status === '草稿' ? '运行中' : '成功',
    now(),
    `${Math.max(3.6, current.members.length * 2.4).toFixed(1)}s`,
    Math.max(360, Math.round(current.members.length * 214)),
    current.supervisorId,
    route.length > 0 ? [current.supervisorId, ...route] : [current.supervisorId],
    input && typeof input === 'object' ? `已接收 ${Object.keys(input as Record<string, unknown>).length} 个输入字段。` : '集群运行已启动。',
  )
  const updated: StudioAgentCluster = {
    ...current,
    status: '运行中',
    runs: [run, ...current.runs],
  }
  clusterStore[clusterId] = updated
  syncAgentClusterModuleRows()
  studioEvents.unshift(event('agent-clusters', 'run', `${current.name} 已启动集群运行`, 'success', { clusterId, runId, input }))
  return run
}

export function getAgentClusterTabData(clusterId: string, tab: string) {
  const cluster = getAgentCluster(clusterId)
  switch (tab) {
    case 'overview':
    case 'editor':
      return cluster
    case 'members':
      return { supervisorId: cluster.supervisorId, members: cluster.members }
    case 'routes':
      return { topology: cluster.topology, routes: cluster.routes, policies: cluster.policies }
    case 'runs':
      return { runs: cluster.runs }
    case 'observability':
      return {
        runs: cluster.runs,
        events: listStudioEvents(8).filter((eventItem) => eventItem.moduleKey === 'agent-clusters'),
      }
    default:
      return cluster
  }
}

function normalizeModuleKey(key: string): StudioModuleKey {
  if (key === 'traces') return 'observability'
  if (['network', 'networks', 'agent-network', 'agent-networks', 'cluster', 'clusters'].includes(key)) return 'agent-clusters'
  if (key in studioModules) return key as StudioModuleKey
  return 'agents'
}

function row(
  id: string,
  name: string,
  scope: string,
  metric: string,
  status: StudioStatus | string,
  kind: string,
  description: string,
  tags: string[],
): StudioRow {
  return {
    id,
    name,
    scope,
    metric,
    status,
    kind,
    updatedAt: now(),
    description,
    tags,
  }
}

function clusterMember(
  agentId: string,
  name: string,
  role: string,
  model: string,
  status: StudioStatus | string,
  load: number,
  tools: string[],
  handoffPolicy: string,
): StudioClusterMember {
  return { agentId, name, role, model, status, load, tools, handoffPolicy }
}

function clusterRoute(
  id: string,
  from: string,
  to: string,
  condition: string,
  mode: StudioClusterRoute['mode'],
  status: StudioStatus | string,
): StudioClusterRoute {
  return { id, from, to, condition, mode, status }
}

function clusterRun(
  id: string,
  title: string,
  status: StudioStatus | string,
  startedAt: string,
  latency: string,
  tokens: number,
  owner: string,
  route: string[],
  summary: string,
): StudioClusterRun {
  return { id, title, status, startedAt, latency, tokens, owner, route, summary }
}

function clusterModuleRow(cluster: StudioAgentCluster): StudioRow {
  return row(
    cluster.id,
    cluster.name,
    cluster.topology,
    `${cluster.members.length} agents / ${cluster.routes.length} routes`,
    cluster.status,
    'agent-network',
    cluster.description,
    ['network', cluster.topology, cluster.supervisorId],
  )
}

function syncAgentClusterModuleRows() {
  studioModules['agent-clusters'].rows = Object.values(clusterStore).map(clusterModuleRow)
}

function trace(
  id: string,
  span: string,
  status: string,
  latency: string,
  input: string,
  output: string,
  tokens: number,
): StudioTrace {
  return { id, span, status, latency, input, output, tokens, startedAt: now() }
}

function review(
  id: string,
  title: string,
  status: StudioReviewItem['status'],
  reviewer: string,
  note: string,
): StudioReviewItem {
  return { id, title, status, reviewer, note }
}

function evaluation(
  id: string,
  dataset: string,
  scorer: string,
  score: number,
  status: StudioEvaluationResult['status'],
  summary: string,
): StudioEvaluationResult {
  return { id, dataset, scorer, score, status, summary, createdAt: now() }
}

function event(
  moduleKey: StudioModuleKey,
  action: string,
  summary: string,
  status: StudioEvent['status'],
  payload?: unknown,
): StudioEvent {
  return {
    id: `studio-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    moduleKey,
    action,
    summary,
    status,
    createdAt: now(),
    payload,
  }
}

function resolveActionSummary(module: StudioModule, action: string) {
  const map: Record<string, string> = {
    run: `${module.title} 已触发一次本地运行`,
    create: `${module.title} 创建任务已进入队列`,
    refresh: `${module.title} 已刷新`,
    export: `${module.title} 导出任务已生成`,
    import: `${module.title} 导入任务已进入队列`,
  }
  return map[action] ?? `${module.title} 已执行 ${action}`
}

function humanizeId(id: string) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}
