import {
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import ApiIcon from '@mui/icons-material/Api'
import DatasetIcon from '@mui/icons-material/Dataset'
import HubIcon from '@mui/icons-material/Hub'
import MemoryIcon from '@mui/icons-material/Memory'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import ScienceIcon from '@mui/icons-material/Science'
import StorageIcon from '@mui/icons-material/Storage'
import TimelineIcon from '@mui/icons-material/Timeline'
import TuneIcon from '@mui/icons-material/Tune'
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { fetchAgentCluster, type StudioAgentCluster, type StudioClusterMember, type StudioModule, type StudioRow } from '../../api/studio'
import { useStudioTheme } from '../../theme/StudioThemeProvider'
import { studioThemeOptions, type StudioThemeId } from '../../theme/studioTheme'

interface ModuleWorkbenchProps {
  module: StudioModule
  row: StudioRow | null
  busy: boolean
  onAction: (action: string) => void | Promise<void>
}

export default function ModuleWorkbench({ module, row, busy, onAction }: ModuleWorkbenchProps) {
  if (module.key === 'agent-clusters') return <AgentClusterWorkbench row={row} busy={busy} onAction={onAction} />
  if (module.key === 'workflows') return <WorkflowWorkbench row={row} busy={busy} onAction={onAction} />
  if (module.key === 'observability') return <TraceWorkbench row={row} busy={busy} onAction={onAction} />
  if (module.key === 'logs') return <LogWorkbench rows={module.rows} busy={busy} onAction={onAction} />
  if (module.key === 'datasets') return <DatasetWorkbench row={row} busy={busy} onAction={onAction} />
  if (module.key === 'experiments' || module.key === 'evaluation' || module.key === 'scorers') {
    return <EvaluationWorkbench module={module} row={row} busy={busy} onAction={onAction} />
  }
  if (module.key === 'tools' || module.key === 'mcps' || module.key === 'tool-providers') {
    return <ToolingWorkbench module={module} row={row} busy={busy} onAction={onAction} />
  }
  if (module.key === 'memory') return <MemoryWorkbench row={row} busy={busy} onAction={onAction} />
  if (module.key === 'background-tasks' || module.key === 'schedules') {
    return <QueueWorkbench module={module} row={row} busy={busy} onAction={onAction} />
  }
  if (module.key === 'settings') return <ThemeSettingsWorkbench busy={busy} onAction={onAction} />
  if (module.key === 'resources' || module.key === 'workspaces') {
    return <SystemWorkbench module={module} row={row} busy={busy} onAction={onAction} />
  }
  return <CapabilityWorkbench module={module} row={row} busy={busy} onAction={onAction} />
}

function ThemeSettingsWorkbench({ busy, onAction }: Pick<ModuleWorkbenchProps, 'busy' | 'onAction'>) {
  const { themeId, setThemeId } = useStudioTheme()
  return (
    <WorkbenchShell icon={<TuneIcon />} title="主题设置" actionLabel="同步设置" busy={busy} onAction={() => onAction('refresh')}>
      <Paper elevation={0} sx={panelSx}>
        <Typography color="text.secondary" sx={{ mb: 1.2 }}>
          选择工作室主题。设置会保存在本机，刷新页面后仍然生效。
        </Typography>
        <RadioGroup value={themeId} onChange={(event) => setThemeId(event.target.value as StudioThemeId)}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, 1fr)' }, gap: 1 }}>
            {studioThemeOptions.map((option) => (
              <Box
                key={option.id}
                role="button"
                tabIndex={0}
                onClick={() => setThemeId(option.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') setThemeId(option.id)
                }}
                sx={{
                  p: 1.3,
                  minHeight: 148,
                  display: 'grid',
                  gridTemplateRows: 'auto 1fr auto',
                  gap: 1,
                  borderRadius: 2,
                  bgcolor: themeId === option.id ? 'var(--studio-accent-soft)' : 'var(--studio-bg)',
                  border: `1px solid ${themeId === option.id ? 'var(--studio-accent)' : 'var(--studio-border)'}`,
                  cursor: 'pointer',
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                  <Typography fontWeight={900}>{option.name}</Typography>
                  <FormControlLabel value={option.id} control={<Radio size="small" />} label="" sx={{ m: 0 }} />
                </Stack>
                <Typography color="text.secondary" fontSize={13} sx={{ lineHeight: 1.6 }}>
                  {option.description}
                </Typography>
                <Stack direction="row" gap={0.6}>
                  {option.swatches.map((color) => (
                    <Box
                      key={color}
                      sx={{
                        width: 22,
                        height: 22,
                        borderRadius: 1,
                        bgcolor: color,
                        border: '1px solid var(--studio-border)',
                      }}
                    />
                  ))}
                </Stack>
              </Box>
            ))}
          </Box>
        </RadioGroup>
      </Paper>
    </WorkbenchShell>
  )
}

function AgentClusterWorkbench({ row, busy, onAction }: Pick<ModuleWorkbenchProps, 'row' | 'busy' | 'onAction'>) {
  const [cluster, setCluster] = useState<StudioAgentCluster | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isClusterRow = Boolean(row && !row.tags.includes('fallback') && row.kind === 'agent-network')

  useEffect(() => {
    if (!row || !isClusterRow) {
      setCluster(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetchAgentCluster(row.id)
      .then((data) => {
        if (!cancelled) setCluster(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '集群详情暂时不可用')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isClusterRow, row])

  const supervisor = useMemo(() => {
    return cluster?.members.find((member) => member.agentId === cluster.supervisorId) ?? cluster?.members[0] ?? null
  }, [cluster])
  const workers = useMemo(() => cluster?.members.filter((member) => member.agentId !== cluster.supervisorId) ?? [], [cluster])

  const handleRun = async () => {
    if (!row || !isClusterRow) return
    setIsLoading(true)
    setError(null)
    try {
      await onAction('run')
      setCluster(await fetchAgentCluster(row.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '集群运行失败')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <WorkbenchShell icon={<HubIcon />} title="Agent 集群运行台" actionLabel="运行集群" busy={busy || isLoading || !isClusterRow} onAction={handleRun}>
      {error && (
        <Paper elevation={0} sx={{ ...panelSx, mb: 1.2, borderColor: 'rgba(240,160,75,0.3)' }}>
          <Typography color="warning.main" fontWeight={850}>{error}</Typography>
        </Paper>
      )}
      {!cluster ? (
        <Paper elevation={0} sx={panelSx}>
          <Typography color="text.secondary">{isLoading ? '正在读取集群拓扑...' : row?.description ?? '选择一个 Agent 集群查看详情。'}</Typography>
        </Paper>
      ) : (
        <Stack gap={1.2}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1.25fr 0.75fr' }, gap: 1.2 }}>
            <Paper elevation={0} sx={panelSx}>
              <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center" sx={{ mb: 1.2 }}>
                <Box>
                  <Typography fontWeight={950}>{cluster.name}</Typography>
                  <Typography color="text.secondary" fontSize={13}>{cluster.description}</Typography>
                </Box>
                <Stack direction="row" gap={0.8}>
                  <Chip size="small" label={topologyLabel(cluster.topology)} variant="outlined" />
                  <Chip size="small" label={cluster.status} color={statusColor(cluster.status)} variant="outlined" />
                </Stack>
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '220px 1fr' }, gap: 1.1, alignItems: 'stretch' }}>
                {supervisor && <ClusterMemberNode member={supervisor} active />}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
                  {workers.map((member) => <ClusterMemberNode key={member.agentId} member={member} />)}
                </Box>
              </Box>
            </Paper>

            <Paper elevation={0} sx={panelSx}>
              <Typography fontWeight={900} sx={{ mb: 1 }}>运行策略</Typography>
              <Stack gap={0.8}>
                {cluster.policies.map((policy) => (
                  <Box key={policy.label} sx={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: 1, p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
                    <Typography color="text.secondary" fontSize={12} fontWeight={800}>{policy.label}</Typography>
                    <Typography fontSize={13}>{policy.value}</Typography>
                  </Box>
                ))}
              </Stack>
              {cluster.runs[0] && (
                <>
                  <Divider sx={{ my: 1.2 }} />
                  <Typography color="text.secondary" fontSize={12} fontWeight={800}>最近运行</Typography>
                  <Typography fontWeight={900} sx={{ mt: 0.5 }}>{cluster.runs[0].title}</Typography>
                  <Typography color="text.secondary" fontSize={13}>{cluster.runs[0].latency} / {cluster.runs[0].tokens} tokens</Typography>
                </>
              )}
            </Paper>
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 1.2 }}>
            <Paper elevation={0} sx={panelSx}>
              <Typography fontWeight={900} sx={{ mb: 1 }}>成员 Agent</Typography>
              <Stack gap={0.8}>
                {cluster.members.map((member) => (
                  <Box key={member.agentId} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.1fr 0.9fr 1fr' }, gap: 1, p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
                    <Box>
                      <Typography fontWeight={850}>{member.name}</Typography>
                      <Typography color="text.secondary" fontSize={12}>{member.role} / {member.model}</Typography>
                    </Box>
                    <Box>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography color="text.secondary" fontSize={12}>负载</Typography>
                        <Typography fontSize={12} fontWeight={800}>{Math.round(member.load * 100)}%</Typography>
                      </Stack>
                      <LinearProgress variant="determinate" value={member.load * 100} sx={{ height: 7, borderRadius: 4, mt: 0.6 }} />
                    </Box>
                    <Stack direction="row" gap={0.6} flexWrap="wrap">
                      {member.tools.slice(0, 3).map((tool) => <Chip key={tool} size="small" label={tool} variant="outlined" />)}
                    </Stack>
                  </Box>
                ))}
              </Stack>
            </Paper>

            <Paper elevation={0} sx={panelSx}>
              <Typography fontWeight={900} sx={{ mb: 1 }}>路由与交接</Typography>
              <Stack gap={0.8}>
                {cluster.routes.map((route) => (
                  <Box key={route.id} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
                    <Stack direction="row" gap={0.8} alignItems="center" flexWrap="wrap">
                      <Typography fontWeight={850}>{route.from}</Typography>
                      <Typography color="text.secondary">→</Typography>
                      <Typography fontWeight={850}>{route.to}</Typography>
                      <Chip size="small" label={modeLabel(route.mode)} variant="outlined" />
                      <Chip size="small" label={route.status} color={statusColor(route.status)} variant="outlined" />
                    </Stack>
                    <Typography color="text.secondary" fontSize={13} sx={{ mt: 0.5 }}>{route.condition}</Typography>
                  </Box>
                ))}
              </Stack>
            </Paper>
          </Box>

          <Paper elevation={0} sx={panelSx}>
            <Typography fontWeight={900} sx={{ mb: 1 }}>集群运行历史</Typography>
            <Stack gap={0.8}>
              {cluster.runs.slice(0, 4).map((run) => (
                <Box key={run.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.2fr 0.8fr 1fr auto' }, gap: 1, p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)', alignItems: 'center' }}>
                  <Box>
                    <Typography fontWeight={850}>{run.title}</Typography>
                    <Typography color="text.secondary" fontSize={12}>{run.summary}</Typography>
                  </Box>
                  <Typography color="text.secondary" fontSize={13}>{formatShortDate(run.startedAt)}</Typography>
                  <Typography color="text.secondary" fontSize={13}>{run.route.join(' → ')}</Typography>
                  <Chip size="small" label={run.status} color={statusColor(run.status)} variant="outlined" />
                </Box>
              ))}
            </Stack>
          </Paper>
        </Stack>
      )}
    </WorkbenchShell>
  )
}

function ClusterMemberNode({ member, active }: { member: StudioClusterMember; active?: boolean }) {
  return (
    <Box
      sx={{
        p: 1.2,
        borderRadius: 1.5,
        bgcolor: active ? 'var(--studio-accent-soft)' : 'var(--studio-bg)',
        border: `1px solid ${active ? 'var(--studio-accent)' : 'var(--studio-border)'}`,
        minHeight: 124,
      }}
    >
      <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center">
        <Typography fontWeight={900}>{member.name}</Typography>
        <Chip size="small" label={member.status} color={statusColor(member.status)} variant="outlined" />
      </Stack>
      <Typography color="text.secondary" fontSize={12} sx={{ mt: 0.4 }}>{member.role} / {member.model}</Typography>
      <Typography color="text.secondary" fontSize={12} sx={{ mt: 1, lineHeight: 1.5 }}>{member.handoffPolicy}</Typography>
    </Box>
  )
}

function WorkflowWorkbench({ row, busy, onAction }: Pick<ModuleWorkbenchProps, 'row' | 'busy' | 'onAction'>) {
  const steps = workflowSteps(row?.id)
  return (
    <WorkbenchShell icon={<AccountTreeIcon />} title="工作流运行图" actionLabel="触发运行" busy={busy} onAction={() => onAction('run')}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1.2fr 0.8fr' }, gap: 1.2 }}>
        <Paper elevation={0} sx={panelSx}>
          <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1.4 }}>
            <Chip label={row?.name ?? 'workflow'} size="small" sx={{ bgcolor: 'var(--studio-surface-soft)' }} />
            <Chip label={row?.status ?? '等待中'} size="small" color={statusColor(row?.status)} variant="outlined" />
          </Stack>
          <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, minmax(120px, 1fr))`, gap: 1.1, overflowX: 'auto' }}>
            {steps.map((step, index) => (
              <Box key={step.id} sx={{ minWidth: 128 }}>
                <Box
                  sx={{
                    p: 1.2,
                    borderRadius: 2,
                    bgcolor: step.status === 'success' ? 'var(--studio-accent-soft)' : step.status === 'running' ? 'var(--studio-surface-soft)' : 'var(--studio-bg)',
                    border: `1px solid ${step.status === 'success' ? 'var(--studio-accent)' : 'var(--studio-border)'}`,
                  }}
                >
                  <Typography fontWeight={900} fontSize={13}>
                    {index + 1}. {step.label}
                  </Typography>
                  <Typography color="text.secondary" fontSize={12} sx={{ mt: 0.4 }}>
                    {step.duration}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Paper>
        <Paper elevation={0} sx={panelSx}>
          <Typography fontWeight={900} sx={{ mb: 1 }}>
            运行输入
          </Typography>
          <CodeBlock>{JSON.stringify({ input: { city: 'Shanghai' }, workflowId: row?.id ?? 'workflow' }, null, 2)}</CodeBlock>
        </Paper>
      </Box>
    </WorkbenchShell>
  )
}

function TraceWorkbench({ row, busy, onAction }: Pick<ModuleWorkbenchProps, 'row' | 'busy' | 'onAction'>) {
  const spans = [
    ['agent.generate', '1.8s', '740 tokens', 'success'],
    ['tool.weatherInfo', '320ms', '126 tokens', 'success'],
    ['memory.thread.load', '42ms', '34 tokens', 'success'],
    ['scorer.answer-relevance', 'queued', '-', 'waiting'],
  ]
  return (
    <WorkbenchShell icon={<TimelineIcon />} title="Trace 时间线" actionLabel="重新采样" busy={busy} onAction={() => onAction('refresh')}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 340px' }, gap: 1.2 }}>
        <Paper elevation={0} sx={panelSx}>
          <Stack gap={1}>
            {spans.map(([name, latency, tokens, status], index) => (
              <Box key={name} sx={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 1, alignItems: 'center' }}>
                <Box sx={{ width: 24, height: 24, borderRadius: 1.2, display: 'grid', placeItems: 'center', bgcolor: status === 'success' ? 'rgba(118,199,107,0.18)' : '#1b1b1b', color: status === 'success' ? 'success.main' : 'text.secondary', fontWeight: 900 }}>
                  {index + 1}
                </Box>
                <Box>
                  <Typography fontWeight={850}>{name}</Typography>
                  <Typography color="text.secondary" fontSize={12}>
                    {latency} / {tokens}
                  </Typography>
                </Box>
                <Chip size="small" label={status} color={status === 'success' ? 'success' : 'warning'} variant="outlined" />
              </Box>
            ))}
          </Stack>
        </Paper>
        <Paper elevation={0} sx={panelSx}>
          <Typography fontWeight={900}>{row?.name ?? 'trace_weather_001'}</Typography>
          <Typography color="text.secondary" sx={{ my: 1, lineHeight: 1.6 }}>
            {row?.description ?? '当前运行的 Trace 详情。'}
          </Typography>
          <CodeBlock>{JSON.stringify({ traceId: row?.id, input: '上海明天天气', output: '温度、湿度、风力、降水概率' }, null, 2)}</CodeBlock>
        </Paper>
      </Box>
    </WorkbenchShell>
  )
}

function LogWorkbench({ rows, busy, onAction }: { rows: StudioRow[]; busy: boolean; onAction: ModuleWorkbenchProps['onAction'] }) {
  return (
    <WorkbenchShell icon={<TimelineIcon />} title="日志流" actionLabel="导出日志" busy={busy} onAction={() => onAction('export')}>
      <Paper elevation={0} sx={panelSx}>
        <Stack direction="row" gap={0.8} flexWrap="wrap" sx={{ mb: 1.2 }}>
          {['24h', 'info', 'warn', 'Weather Agent', 'trace_weather_001'].map((item) => (
            <Chip key={item} size="small" label={item} variant="outlined" />
          ))}
        </Stack>
        <Stack gap={0.7}>
          {rows.map((item) => (
            <Box key={item.id} sx={{ display: 'grid', gridTemplateColumns: '88px 64px 1fr', gap: 1, p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
              <Typography color="text.secondary" fontSize={13}>{item.name}</Typography>
              <Typography color={item.scope === 'warn' ? 'warning.main' : 'success.main'} fontWeight={800} fontSize={13}>{item.scope}</Typography>
              <Typography color="text.secondary" fontSize={13}>{item.metric}</Typography>
            </Box>
          ))}
        </Stack>
      </Paper>
    </WorkbenchShell>
  )
}

function DatasetWorkbench({ row, busy, onAction }: Pick<ModuleWorkbenchProps, 'row' | 'busy' | 'onAction'>) {
  const items = [
    ['001', '上海明天天气？', '温度、湿度、风力、降水'],
    ['002', '北京周末会下雨吗？', '降水概率和建议'],
    ['003', '杭州适合穿什么？', '天气和穿衣建议'],
  ]
  return (
    <WorkbenchShell icon={<DatasetIcon />} title="数据集样本" actionLabel="生成样本" busy={busy} onAction={() => onAction('generate')}>
      <Paper elevation={0} sx={panelSx}>
        <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1.2 }}>
          <Chip label={row?.name ?? 'dataset'} size="small" sx={{ bgcolor: 'var(--studio-surface-soft)' }} />
          <Chip label={row?.metric ?? 'v1'} size="small" variant="outlined" />
        </Stack>
        <Stack gap={0.8}>
          {items.map(([id, input, expected]) => (
            <Box key={id} sx={{ display: 'grid', gridTemplateColumns: '48px 1fr 1fr', gap: 1, p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
              <Typography fontWeight={900}>{id}</Typography>
              <Typography color="text.secondary">{input}</Typography>
              <Typography color="text.secondary">{expected}</Typography>
            </Box>
          ))}
        </Stack>
      </Paper>
    </WorkbenchShell>
  )
}

function EvaluationWorkbench({ module, row, busy, onAction }: ModuleWorkbenchProps) {
  const score = row?.metric.match(/\d+/)?.[0] ?? '92'
  return (
    <WorkbenchShell icon={<ScienceIcon />} title="评估控制台" actionLabel="运行评估" busy={busy} onAction={() => onAction('run')}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 1.2 }}>
        {module.rows.slice(0, 3).map((item) => (
          <Paper key={item.id} elevation={0} sx={panelSx}>
            <Typography color="text.secondary" fontSize={12} fontWeight={800}>{item.name}</Typography>
            <Typography variant="h5" sx={{ my: 0.8 }}>{item.metric}</Typography>
            <LinearProgress variant="determinate" value={Number.parseInt(item.metric, 10) || Number(score)} sx={{ height: 8, borderRadius: 4 }} />
          </Paper>
        ))}
      </Box>
    </WorkbenchShell>
  )
}

function ToolingWorkbench({ module, row, busy, onAction }: ModuleWorkbenchProps) {
  return (
    <WorkbenchShell icon={<ApiIcon />} title={module.key === 'mcps' ? 'MCP 资源' : '工具 Schema'} actionLabel="测试调用" busy={busy} onAction={() => onAction('execute')}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 1.2 }}>
        <Paper elevation={0} sx={panelSx}>
          <Typography fontWeight={900} sx={{ mb: 1 }}>{row?.name ?? module.title}</Typography>
          <CodeBlock>{JSON.stringify(schemaFor(row), null, 2)}</CodeBlock>
        </Paper>
        <Paper elevation={0} sx={panelSx}>
          <Typography fontWeight={900} sx={{ mb: 1 }}>执行记录</Typography>
          <Stack gap={0.8}>
            {['schema validated', 'approval checked', 'trace linked'].map((item) => (
              <Chip key={item} label={item} variant="outlined" sx={{ width: 'fit-content' }} />
            ))}
          </Stack>
        </Paper>
      </Box>
    </WorkbenchShell>
  )
}

function MemoryWorkbench({ row, busy, onAction }: Pick<ModuleWorkbenchProps, 'row' | 'busy' | 'onAction'>) {
  return (
    <WorkbenchShell icon={<MemoryIcon />} title="记忆线程" actionLabel="同步记忆" busy={busy} onAction={() => onAction('refresh')}>
      <Paper elevation={0} sx={panelSx}>
        {['线程消息', '工作记忆', '观测记忆', '缓冲状态'].map((item, index) => (
          <Box key={item} sx={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 1, py: 0.8, borderBottom: index < 3 ? '1px solid var(--studio-border)' : 0 }}>
            <Typography fontWeight={850}>{item}</Typography>
            <Typography color="text.secondary">{row?.scope ?? 'weather-agent'}</Typography>
            <Chip size="small" label={index === 3 ? 'empty' : 'ready'} color="success" variant="outlined" />
          </Box>
        ))}
      </Paper>
    </WorkbenchShell>
  )
}

function QueueWorkbench({ module, row, busy, onAction }: ModuleWorkbenchProps) {
  const progress = Number.parseInt(row?.metric ?? '0', 10)
  return (
    <WorkbenchShell icon={<StorageIcon />} title={module.key === 'schedules' ? '调度历史' : '后台任务'} actionLabel={module.key === 'schedules' ? '暂停/恢复' : '刷新任务'} busy={busy} onAction={() => onAction('refresh')}>
      <Paper elevation={0} sx={panelSx}>
        <Stack gap={1.2}>
          <Typography fontWeight={900}>{row?.name ?? module.title}</Typography>
          <LinearProgress variant="determinate" value={Number.isFinite(progress) ? progress : 50} sx={{ height: 10, borderRadius: 5 }} />
          <Typography color="text.secondary">{row?.description ?? '等待下一个运行事件。'}</Typography>
        </Stack>
      </Paper>
    </WorkbenchShell>
  )
}

function SystemWorkbench({ module, row, busy, onAction }: ModuleWorkbenchProps) {
  return (
    <WorkbenchShell icon={<TuneIcon />} title="系统资源" actionLabel="同步状态" busy={busy} onAction={() => onAction('refresh')}>
      <Paper elevation={0} sx={panelSx}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 1 }}>
          {module.kpis.map((item) => (
            <Box key={item.label} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
              <Typography color="text.secondary" fontSize={12}>{item.label}</Typography>
              <Typography fontWeight={900}>{item.value}</Typography>
            </Box>
          ))}
        </Box>
        {row && (
          <>
            <Divider sx={{ my: 1.3 }} />
            <Typography color="text.secondary">{row.description}</Typography>
          </>
        )}
      </Paper>
    </WorkbenchShell>
  )
}

function CapabilityWorkbench({ module, row, busy, onAction }: ModuleWorkbenchProps) {
  return (
    <WorkbenchShell icon={<PlayArrowIcon />} title="功能控制台" actionLabel="执行动作" busy={busy} onAction={() => onAction('run')}>
      <Paper elevation={0} sx={panelSx}>
        <Typography color="text.secondary" sx={{ mb: 1 }}>{row?.description ?? module.description}</Typography>
        <Stack direction="row" gap={0.8} flexWrap="wrap">
          {module.capabilities.map((item) => (
            <Chip key={item} label={item} variant="outlined" />
          ))}
        </Stack>
      </Paper>
    </WorkbenchShell>
  )
}

function WorkbenchShell({
  icon,
  title,
  actionLabel,
  busy,
  onAction,
  children,
}: {
  icon: ReactElement
  title: string
  actionLabel: string
  busy: boolean
  onAction: () => void | Promise<void>
  children: ReactNode
}) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1 }}>
        <Stack direction="row" alignItems="center" gap={1}>
          <Box sx={{ color: 'var(--studio-accent)', display: 'grid', placeItems: 'center' }}>{icon}</Box>
          <Typography fontWeight={900}>{title}</Typography>
        </Stack>
        <Button size="small" startIcon={<PlayArrowIcon />} disabled={busy} onClick={onAction}>
          {actionLabel}
        </Button>
      </Stack>
      {children}
    </Box>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.2,
        borderRadius: 1.5,
        bgcolor: 'var(--studio-bg)',
        border: '1px solid var(--studio-border)',
        color: 'text.primary',
        overflow: 'auto',
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      {children}
    </Box>
  )
}

const panelSx = {
  p: 1.4,
  bgcolor: 'var(--studio-surface)',
  border: '1px solid var(--studio-border)',
  borderRadius: 2,
}

function workflowSteps(workflowId?: string | null) {
  if (workflowId?.includes('dataset')) {
    return [
      { id: 'load', label: '读取数据集', status: 'success', duration: '180ms' },
      { id: 'run', label: '批量运行', status: 'running', duration: '2.4s' },
      { id: 'score', label: '评分', status: 'pending', duration: '-' },
      { id: 'persist', label: '写入实验', status: 'pending', duration: '-' },
    ]
  }
  return [
    { id: 'input', label: '接收输入', status: 'success', duration: '24ms' },
    { id: 'context', label: '解析上下文', status: 'success', duration: '42ms' },
    { id: 'agent', label: '调用 Agent', status: workflowId?.includes('handoff') ? 'running' : 'success', duration: '1.3s' },
    { id: 'result', label: '写入结果', status: 'pending', duration: '-' },
  ]
}

function schemaFor(row: StudioRow | null) {
  if (row?.id === 'weatherInfo') {
    return {
      input: { location: 'string', unit: 'celsius|fahrenheit' },
      output: { temperature: 'number', humidity: 'number', wind: 'string', precipitation: 'string' },
      approval: false,
    }
  }
  return {
    input: { query: 'string', requestContext: 'object' },
    output: { result: 'unknown', traceId: 'string' },
    approval: row?.status === '需要授权',
  }
}

function topologyLabel(topology: StudioAgentCluster['topology']) {
  const labels: Record<StudioAgentCluster['topology'], string> = {
    supervisor: 'Supervisor',
    pipeline: 'Pipeline',
    committee: 'Committee',
    swarm: 'Swarm',
  }
  return labels[topology]
}

function modeLabel(mode: 'delegate' | 'parallel' | 'review' | 'fallback') {
  const labels = {
    delegate: '委派',
    parallel: '并行',
    review: '审查',
    fallback: '回退',
  }
  return labels[mode]
}

function formatShortDate(value: string) {
  return new Date(value).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function statusColor(status?: string | null): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (!status) return 'default'
  if (['在线', '成功', '通过'].includes(status)) return 'success'
  if (['运行中'].includes(status)) return 'primary'
  if (['草稿', '等待中', '需要授权', '只读', '关注', '待确认'].includes(status)) return 'warning'
  if (['失败', '退回'].includes(status)) return 'error'
  return 'default'
}
