import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Box, Chip, Paper, Stack, Tab, Tabs, Typography } from '@mui/material'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import ApiIcon from '@mui/icons-material/Api'
import BoltIcon from '@mui/icons-material/Bolt'
import CodeIcon from '@mui/icons-material/Code'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import LinkIcon from '@mui/icons-material/Link'
import MemoryIcon from '@mui/icons-material/Memory'
import PsychologyAltIcon from '@mui/icons-material/PsychologyAlt'
import ScienceIcon from '@mui/icons-material/Science'
import TimelineIcon from '@mui/icons-material/Timeline'
import type { StudioAgent } from '../../api/studio'

interface AgentConsolePanelProps {
  agent?: StudioAgent
  messageCount: number
  isStreaming: boolean
  socketState: number
}

const fallbackPrompt = [
  '你是一个可靠的天气助手，负责提供准确、简洁的天气信息。',
  '',
  '- 如果用户没有提供地点，先询问地点',
  '- 回答中包含温度、湿度、风力和降水信息',
  '- 保持简洁，但不要遗漏关键事实',
].join('\n')

export default function AgentConsolePanel({
  agent,
  messageCount,
  isStreaming,
  socketState,
}: AgentConsolePanelProps) {
  const [tab, setTab] = useState('overview')
  const promptLines = useMemo(() => (agent?.prompt ?? fallbackPrompt).split('\n'), [agent?.prompt])

  return (
    <Paper
      elevation={0}
      sx={{
        display: { xs: 'none', lg: 'grid' },
        minHeight: 0,
        gridTemplateRows: 'auto auto 1fr',
        overflow: 'hidden',
        bgcolor: 'var(--studio-surface)',
        borderLeft: '1px solid var(--studio-border)',
      }}
    >
      <Box sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1.2} sx={{ mb: 1.5 }}>
          <PsychologyAltIcon />
          <Typography variant="h6">{agent?.name ?? 'Weather Agent'}</Typography>
        </Stack>
        <Stack direction="row" gap={0.8} flexWrap="wrap">
          <Chip
            size="small"
            icon={<ContentCopyIcon />}
            label={agent?.id ?? 'weather-agent'}
            sx={{ bgcolor: 'var(--studio-surface-soft)', color: 'text.secondary' }}
          />
          <Chip size="small" icon={<CodeIcon />} label={agent?.model ?? 'claude-sonnet-4-6'} variant="outlined" />
        </Stack>
      </Box>
      <Tabs
        value={tab}
        onChange={(_, value: string) => setTab(value)}
        variant="scrollable"
        sx={{
          minHeight: 44,
          px: 1.2,
          borderBottom: '1px solid var(--studio-border)',
          '& .MuiTab-root': { minHeight: 44, px: 1.2, color: 'text.secondary', fontWeight: 700 },
          '& .Mui-selected': { color: 'text.primary' },
          '& .MuiTabs-indicator': { bgcolor: 'text.primary' },
        }}
      >
        <Tab value="overview" label="概览" />
        <Tab value="model" label="模型" />
        <Tab value="memory" label="记忆" />
        <Tab value="tracing" label="追踪" />
      </Tabs>
      <Box sx={{ minHeight: 0, overflowY: 'auto', p: 2 }}>
        {tab === 'overview' && (
          <Stack gap={2.2}>
            <Section title="记忆" icon={<MemoryIcon fontSize="small" />}>
              <Tag icon={<BoltIcon fontSize="small" />} label={agent?.memoryEnabled ? '已启用' : '未启用'} green={agent?.memoryEnabled} />
            </Section>
            <Section title="工具" icon={<ApiIcon fontSize="small" />}>
              <TagList items={agent?.tools ?? ['weatherInfo', 'simpleMcpTool']} />
            </Section>
            <Section title="工作流" icon={<AccountTreeIcon fontSize="small" />}>
              <TagList items={agent?.workflows ?? ['lessComplexWorkflow']} />
            </Section>
            <Section title="处理器">
              <TagList items={agent?.processors ?? []} />
            </Section>
            <Section title="评分器" icon={<ScienceIcon fontSize="small" />}>
              <TagList items={agent?.scorers ?? []} />
            </Section>
            <Section title="System Prompt">
              <PromptPreview lines={promptLines} />
            </Section>
          </Stack>
        )}
        {tab === 'model' && (
          <Stack gap={1.2}>
            <InfoRow label="供应商" value={agent?.provider ?? 'anthropic'} />
            <InfoRow label="模型" value={agent?.model ?? 'claude-sonnet-4-6'} />
            <InfoRow label="温度" value={String(agent?.temperature ?? 0.4)} />
            <InfoRow label="最大步骤" value={String(agent?.maxSteps ?? 4)} />
          </Stack>
        )}
        {tab === 'memory' && (
          <Stack gap={1.2}>
            <Chip label={agent?.memoryEnabled ? '记忆已启用' : '记忆未启用'} color={agent?.memoryEnabled ? 'success' : 'warning'} variant="outlined" />
            <Chip label={`线程 ${agent?.memoryThreads.length ?? 0}`} variant="outlined" />
            <Chip label={`消息 ${messageCount}`} variant="outlined" />
          </Stack>
        )}
        {tab === 'tracing' && (
          <Stack gap={1.2}>
            <Chip icon={<TimelineIcon />} label={agent?.tracingEnabled ? '追踪已启用' : '追踪未启用'} color={agent?.tracingEnabled ? 'success' : 'warning'} variant="outlined" />
            <Chip label={socketState === WebSocket.OPEN ? '连接正常' : '正在重连'} color={socketState === WebSocket.OPEN ? 'success' : 'warning'} variant="outlined" />
            <Chip label={isStreaming ? '流式输出中' : '空闲'} variant="outlined" />
          </Stack>
        )}
      </Box>
    </Paper>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: ReactElement
  children: ReactNode
}) {
  return (
    <Box>
      <Stack direction="row" alignItems="center" gap={0.5} sx={{ mb: 0.9 }}>
        <Typography color="text.secondary" fontWeight={700}>
          {title}
        </Typography>
        {icon}
        <LinkIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
      </Stack>
      {children}
    </Box>
  )
}

function TagList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        暂无
      </Typography>
    )
  }
  return (
    <Stack direction="row" gap={0.8} flexWrap="wrap">
      {items.map((item) => (
        <Tag key={item} label={item} />
      ))}
    </Stack>
  )
}

function Tag({
  label,
  icon,
  green,
}: {
  label: string
  icon?: ReactElement
  green?: boolean
}) {
  return (
    <Chip
      size="small"
      icon={icon}
      label={label}
      sx={{
        width: 'fit-content',
        bgcolor: green ? 'var(--studio-accent-soft)' : 'var(--studio-surface-soft)',
        color: green ? 'var(--studio-accent)' : 'text.primary',
        border: `1px solid ${green ? 'var(--studio-accent-soft)' : 'var(--studio-border)'}`,
        fontWeight: 800,
        '& .MuiChip-icon': {
          color: green ? 'var(--studio-accent)' : 'text.secondary',
        },
      }}
    />
  )
}

function PromptPreview({ lines }: { lines: string[] }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr',
        border: '1px solid var(--studio-border)',
        borderRadius: 2,
        overflow: 'hidden',
        bgcolor: 'var(--studio-bg)',
        fontFamily: '"Cascadia Code", Consolas, monospace',
        fontSize: 12,
      }}
    >
      <Box sx={{ py: 1, color: 'text.disabled', textAlign: 'right', pr: 1, bgcolor: 'var(--studio-surface-soft)' }}>
        {lines.map((_, index) => (
          <Box key={index}>{index + 1}</Box>
        ))}
      </Box>
      <Box sx={{ py: 1, px: 1.2, whiteSpace: 'pre-wrap', color: 'text.primary' }}>{lines.join('\n')}</Box>
    </Box>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" gap={1}>
      <Typography color="text.secondary">{label}</Typography>
      <Typography fontWeight={800}>{value}</Typography>
    </Stack>
  )
}
