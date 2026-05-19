import type React from 'react'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import ApiIcon from '@mui/icons-material/Api'
import AssessmentIcon from '@mui/icons-material/Assessment'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import ChatIcon from '@mui/icons-material/Chat'
import DatasetIcon from '@mui/icons-material/Dataset'
import FolderIcon from '@mui/icons-material/Folder'
import HubIcon from '@mui/icons-material/Hub'
import GroupsIcon from '@mui/icons-material/Groups'
import MemoryIcon from '@mui/icons-material/Memory'
import PsychologyAltIcon from '@mui/icons-material/PsychologyAlt'
import ScienceIcon from '@mui/icons-material/Science'
import StorageIcon from '@mui/icons-material/Storage'
import TerminalIcon from '@mui/icons-material/Terminal'
import TimelineIcon from '@mui/icons-material/Timeline'
import TuneIcon from '@mui/icons-material/Tune'
import ViewInArIcon from '@mui/icons-material/ViewInAr'
import WorkHistoryIcon from '@mui/icons-material/WorkHistory'

export interface StudioNavItem {
  label: string
  path: string
  icon: React.ReactElement
}

export const primitiveItems: StudioNavItem[] = [
  { label: '智能体', path: '/agents/weather-agent/chat/new', icon: <PsychologyAltIcon fontSize="small" /> },
  { label: 'Agent 集群', path: '/agent-clusters', icon: <GroupsIcon fontSize="small" /> },
  { label: '提示词', path: '/prompts', icon: <ChatIcon fontSize="small" /> },
  { label: '工作流', path: '/workflows', icon: <AccountTreeIcon fontSize="small" /> },
  { label: '处理器', path: '/processors', icon: <TuneIcon fontSize="small" /> },
  { label: 'MCP 服务', path: '/mcps', icon: <MemoryIcon fontSize="small" /> },
  { label: '工具', path: '/tools', icon: <ApiIcon fontSize="small" /> },
  { label: '工作区', path: '/workspaces', icon: <FolderIcon fontSize="small" /> },
  { label: '请求上下文', path: '/request-context', icon: <TerminalIcon fontSize="small" /> },
]

export const runtimeItems: StudioNavItem[] = [
  { label: '记忆', path: '/memory', icon: <MemoryIcon fontSize="small" /> },
  { label: 'Agent Builder', path: '/agent-builder', icon: <AutoFixHighIcon fontSize="small" /> },
  { label: '向量库', path: '/vectors', icon: <StorageIcon fontSize="small" /> },
  { label: '嵌入模型', path: '/embedders', icon: <ViewInArIcon fontSize="small" /> },
  { label: '工具供应商', path: '/tool-providers', icon: <ApiIcon fontSize="small" /> },
  { label: '处理器供应商', path: '/processor-providers', icon: <TuneIcon fontSize="small" /> },
  { label: '后台任务', path: '/background-tasks', icon: <WorkHistoryIcon fontSize="small" /> },
  { label: '调度', path: '/schedules', icon: <TimelineIcon fontSize="small" /> },
]

export const evaluationItems: StudioNavItem[] = [
  { label: '概览', path: '/evaluation', icon: <AssessmentIcon fontSize="small" /> },
  { label: '评分器', path: '/scorers', icon: <ScienceIcon fontSize="small" /> },
  { label: '数据集', path: '/datasets', icon: <DatasetIcon fontSize="small" /> },
  { label: '实验', path: '/experiments', icon: <StorageIcon fontSize="small" /> },
]

export const observabilityItems: StudioNavItem[] = [
  { label: '指标', path: '/metrics', icon: <TimelineIcon fontSize="small" /> },
  { label: '追踪', path: '/observability', icon: <HubIcon fontSize="small" /> },
  { label: '日志', path: '/logs', icon: <TerminalIcon fontSize="small" /> },
]

export const utilityItems: StudioNavItem[] = [
  { label: '设置', path: '/settings', icon: <TuneIcon fontSize="small" /> },
  { label: '资源', path: '/resources', icon: <FolderIcon fontSize="small" /> },
]

export const studioModules = {
  agents: fallbackModule('agents', '智能体', 'Primitives', '管理 Agent、模型、提示词、工具、记忆和运行入口。', '新建智能体'),
  'agent-clusters': fallbackModule('agent-clusters', 'Agent 集群', 'Primitives', '管理 routing agent、sub-agents、路由策略、共享记忆与集群运行。', '新建集群'),
  prompts: fallbackModule('prompts', '提示词', 'Primitives', '维护可复用 Prompt block、变量、版本和发布状态。', '新建提示词'),
  workflows: fallbackModule('workflows', '工作流', 'Primitives', '运行、恢复、重启和回放确定性的多步骤工作流。', '创建运行'),
  processors: fallbackModule('processors', '处理器', 'Primitives', '配置输入、输出、安全和工具调用处理器。', '添加处理器'),
  mcps: fallbackModule('mcps', 'MCP 服务', 'Primitives', '连接外部 MCP Server，查看工具、资源和授权状态。', '连接服务'),
  tools: fallbackModule('tools', '工具', 'Primitives', '查看工具 schema、权限策略、执行记录和失败原因。', '注册工具'),
  workspaces: fallbackModule('workspaces', '工作区', 'Primitives', '组织项目、包、运行时环境和本地资源。', '新建工作区'),
  'request-context': fallbackModule('request-context', '请求上下文', 'Primitives', '调试运行时上下文、租户变量和追踪标签。', '保存上下文'),
  memory: fallbackModule('memory', '记忆', 'Runtime', '管理线程、工作记忆和观测记忆状态。', '新建记忆线程'),
  'agent-builder': fallbackModule('agent-builder', 'Agent Builder', 'Runtime', '从模板、注册表和工作流生成新的 Agent。', '运行构建器'),
  vectors: fallbackModule('vectors', '向量库', 'Runtime', '查看向量存储、索引维度和集合状态。', '连接向量库'),
  embedders: fallbackModule('embedders', '嵌入模型', 'Runtime', '查看 embedding provider、模型、维度和调用状态。', '添加嵌入模型'),
  'tool-providers': fallbackModule('tool-providers', '工具供应商', 'Runtime', '管理第三方工具包、安装状态和工具发现。', '安装供应商'),
  'processor-providers': fallbackModule('processor-providers', '处理器供应商', 'Runtime', '管理处理器包、规则集和默认策略。', '安装处理器包'),
  evaluation: fallbackModule('evaluation', '评估概览', 'Evaluation', '汇总评分器、数据集、实验结果和回归趋势。', '运行评估'),
  scorers: fallbackModule('scorers', '评分器', 'Evaluation', '管理 LLM-as-judge、规则评分器和人工审查标准。', '新建评分器'),
  datasets: fallbackModule('datasets', '数据集', 'Evaluation', '维护测试样本、期望输出、版本和批量生成任务。', '导入数据'),
  experiments: fallbackModule('experiments', '实验', 'Evaluation', '比较模型、提示词和工具组合在数据集上的表现。', '启动实验'),
  metrics: fallbackModule('metrics', '指标', 'Observability', '观察调用量、延迟、Token、成本和失败率。', '刷新指标'),
  observability: fallbackModule('observability', '追踪', 'Observability', '检查 Trace、Span、输入输出、Token 用量和运行状态。', '打开 Trace'),
  logs: fallbackModule('logs', '日志', 'Observability', '按时间、级别、实体和 Trace 过滤运行时日志。', '导出日志'),
  'background-tasks': fallbackModule('background-tasks', '后台任务', 'Runtime', '查看长任务、异步工具调用、实验运行和事件流状态。', '刷新任务'),
  schedules: fallbackModule('schedules', '调度', 'Runtime', '列出工作流调度、触发历史，并支持暂停/恢复。', '新建调度'),
  settings: fallbackModule('settings', '设置', 'Studio', '管理模型供应商、API Key、运行时和实验开关。', '保存设置'),
  resources: fallbackModule('resources', '资源', 'Studio', '查看文档、运行时资源、模板和本地引用。', '打开资源'),
} as const

function fallbackModule(key: string, title: string, eyebrow: string, description: string, action: string) {
  return {
    key,
    title,
    eyebrow,
    description,
    action,
    columns: ['名称', '范围', '指标', '状态'] as [string, string, string, string],
    capabilities: ['连接后端 Studio API 后显示完整能力'],
    kpis: [
      { label: '状态', value: '本地', delta: '等待 API', tone: 'neutral' as const },
      { label: '来源', value: 'Mastra', delta: '功能映射', tone: 'success' as const },
      { label: '页面', value: '可用', delta: '前端兜底', tone: 'neutral' as const },
    ],
    rows: [
      {
        id: key,
        name: title,
        scope: eyebrow,
        metric: 'Studio API',
        status: '等待中',
        kind: key,
        updatedAt: new Date().toISOString(),
        description,
        tags: ['fallback'],
      },
    ],
  }
}
