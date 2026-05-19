import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import BoltIcon from '@mui/icons-material/Bolt'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import FilterAltIcon from '@mui/icons-material/FilterAlt'
import LaunchIcon from '@mui/icons-material/Launch'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import SearchIcon from '@mui/icons-material/Search'
import { useNavigate, useParams } from 'react-router-dom'
import {
  fetchStudioEvents,
  fetchStudioModule,
  runStudioAction,
  type StudioEvent,
  type StudioModule,
  type StudioRow,
} from '../api/studio'
import FileMigrationPanel from '../features/studio/FileMigrationPanel'
import ModuleWorkbench from '../features/studio/ModuleWorkbench'
import { studioModules } from '../features/studio/studioCatalog'

type ModuleKey = keyof typeof studioModules

const statusOptions = ['全部', '在线', '草稿', '运行中', '等待中', '成功', '失败', '需要授权', '只读']

export default function StudioModulePage() {
  const params = useParams()
  const navigate = useNavigate()
  const moduleKey = (params.moduleKey ?? 'agents') as ModuleKey
  const fallbackModule = studioModules[moduleKey] ?? studioModules.agents
  const [module, setModule] = useState<StudioModule>(fallbackModule)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('全部')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<StudioEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isActing, setIsActing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetchStudioModule(moduleKey, query, status)
      .then((data) => {
        if (cancelled) return
        setModule(data)
        setSelectedId((current) => (data.rows.some((row) => row.id === current) ? current : data.rows[0]?.id ?? null))
      })
      .catch((err) => {
        if (cancelled) return
        setModule(fallbackModule)
        setError(err instanceof Error ? err.message : 'Studio API 暂时不可用')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fallbackModule, moduleKey, query, status])

  useEffect(() => {
    fetchStudioEvents()
      .then(setEvents)
      .catch(() => setEvents([]))
  }, [])

  useEffect(() => {
    setSelectedId(null)
    setNotice(null)
  }, [moduleKey])

  const selectedRow = useMemo(() => {
    return module.rows.find((row) => row.id === selectedId) ?? module.rows[0] ?? null
  }, [module.rows, selectedId])

  const handleAction = async (action: string) => {
    setIsActing(true)
    setNotice(null)
    try {
      const event = await runStudioAction(module.key, action, { selectedId: selectedRow?.id })
      setNotice(event.summary)
      const [nextModule, nextEvents] = await Promise.all([
        fetchStudioModule(moduleKey, query, status),
        fetchStudioEvents(),
      ])
      setModule(nextModule)
      setEvents(nextEvents)
    } catch (err) {
      setError(err instanceof Error ? err.message : '动作执行失败')
    } finally {
      setIsActing(false)
    }
  }

  return (
    <Paper
      elevation={0}
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr',
        overflow: 'hidden',
        bgcolor: 'background.paper',
        border: '1px solid var(--studio-border)',
        borderRadius: 3,
      }}
    >
      <Box sx={{ px: 2.4, py: 2.1 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'flex-start' }} justifyContent="space-between" gap={2}>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <Typography variant="caption" color="text.secondary" fontWeight={800}>
                {module.eyebrow}
              </Typography>
              {isLoading && <CircularProgress size={14} />}
            </Stack>
            <Typography variant="h4" sx={{ mt: 0.4 }}>
              {module.title}
            </Typography>
            <Typography color="text.secondary" sx={{ maxWidth: 820, mt: 0.8, lineHeight: 1.65 }}>
              {module.description}
            </Typography>
          </Box>
          <Stack direction="row" gap={1} flexWrap="wrap" sx={{ justifyContent: { xs: 'flex-start', md: 'flex-end' } }}>
            {module.docsHref && (
              <Button variant="outlined" startIcon={<LaunchIcon />} onClick={() => window.open(module.docsHref, '_blank')}>
                文档
              </Button>
            )}
            <Button variant="outlined" startIcon={<RefreshIcon />} disabled={isActing} onClick={() => handleAction('refresh')}>
              刷新
            </Button>
            <Button variant="outlined" startIcon={<PlayArrowIcon />} disabled={isActing} onClick={() => handleAction('run')}>
              运行
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} disabled={isActing} onClick={() => handleAction('create')}>
              {module.action}
            </Button>
          </Stack>
        </Stack>
      </Box>

      <Box sx={{ px: 2.4, pb: 1.5 }}>
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
          <TextField
            size="small"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${module.title}`}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ minWidth: { xs: '100%', sm: 280 } }}
          />
          <TextField
            select
            size="small"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <FilterAltIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ minWidth: 150 }}
          >
            {statusOptions.map((item) => (
              <MenuItem key={item} value={item}>
                {item}
              </MenuItem>
            ))}
          </TextField>
          <Chip icon={<BoltIcon />} label={`${module.rows.length} 项`} variant="outlined" />
          <Button
            variant="text"
            startIcon={<FileDownloadIcon />}
            disabled={isActing}
            onClick={() => handleAction('export')}
            sx={{ color: 'text.secondary' }}
          >
            导出
          </Button>
        </Stack>
        {(notice || error) && (
          <Alert severity={notice ? 'success' : 'warning'} sx={{ mt: 1.2 }}>
            {notice ?? error}
          </Alert>
        )}
      </Box>

      <Box sx={{ minHeight: 0, overflow: 'auto', px: 2.4, pb: 2.4 }}>
        {moduleKey === 'workspaces' && <FileMigrationPanel />}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1fr) 360px' }, gap: 1.6 }}>
          <Stack gap={1.6} sx={{ minWidth: 0 }}>
            <KpiStrip module={module} />
            <ModuleWorkbench module={module} row={selectedRow} busy={isActing} onAction={handleAction} />
            <Paper
              elevation={0}
              sx={{
                minWidth: 760,
                overflow: 'hidden',
                bgcolor: 'var(--studio-surface)',
                border: '1px solid var(--studio-border)',
                borderRadius: 2,
              }}
            >
              <GridRow muted cells={module.columns} />
              <Divider />
              {module.rows.map((row) => (
                <GridRow
                  key={row.id}
                  row={row}
                  cells={[row.name, row.scope, row.metric, row.status]}
                  active={row.id === selectedRow?.id}
                  onClick={() => {
                    if (module.key === 'agents') {
                      navigate(`/agents/${row.id}/chat/new`)
                      return
                    }
                    setSelectedId(row.id)
                  }}
                />
              ))}
              {module.rows.length === 0 && (
                <Typography color="text.secondary" sx={{ p: 3 }}>
                  没有匹配项。调整搜索或清除筛选后再试。
                </Typography>
              )}
            </Paper>
          </Stack>
          <DetailPanel module={module} row={selectedRow} events={events} onAction={handleAction} busy={isActing} />
        </Box>
      </Box>
    </Paper>
  )
}

function KpiStrip({ module }: { module: StudioModule }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 1 }}>
      {module.kpis.map((item) => (
        <Paper
          key={item.label}
          elevation={0}
          sx={{
            p: 1.5,
            bgcolor: 'var(--studio-surface)',
            border: '1px solid var(--studio-border)',
            borderRadius: 2,
          }}
        >
          <Typography color="text.secondary" fontSize={12} fontWeight={800}>
            {item.label}
          </Typography>
          <Stack direction="row" alignItems="baseline" justifyContent="space-between" gap={1} sx={{ mt: 0.8 }}>
            <Typography variant="h5">{item.value}</Typography>
            <Typography color={toneColor(item.tone)} fontWeight={800} fontSize={13}>
              {item.delta}
            </Typography>
          </Stack>
        </Paper>
      ))}
    </Box>
  )
}

function DetailPanel({
  module,
  row,
  events,
  onAction,
  busy,
}: {
  module: StudioModule
  row: StudioRow | null
  events: StudioEvent[]
  onAction: (action: string) => void
  busy: boolean
}) {
  return (
    <Paper
      elevation={0}
      sx={{
        minHeight: 420,
        bgcolor: 'var(--studio-surface)',
        border: '1px solid var(--studio-border)',
        borderRadius: 2,
        p: 1.6,
      }}
    >
      <Typography fontWeight={900}>详情</Typography>
      {row ? (
        <Stack gap={1.4} sx={{ mt: 1.4 }}>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Chip label={row.kind} size="small" sx={{ bgcolor: 'var(--studio-surface-soft)' }} />
            <Chip label={row.status} size="small" color={statusColor(row.status)} variant="outlined" />
          </Stack>
          <Box>
            <Typography variant="h6">{row.name}</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5, lineHeight: 1.6 }}>
              {row.description}
            </Typography>
          </Box>
          <Stack direction="row" gap={0.8} flexWrap="wrap">
            {row.tags.map((tag) => (
              <Chip key={tag} size="small" label={tag} variant="outlined" />
            ))}
          </Stack>
          <Divider />
          <Box>
            <Typography color="text.secondary" fontWeight={800} fontSize={12}>
              Mastra 能力映射
            </Typography>
            <Stack gap={0.8} sx={{ mt: 1 }}>
              {module.capabilities.map((item) => (
                <Box key={item} sx={{ display: 'grid', gridTemplateColumns: '8px 1fr', gap: 1, alignItems: 'center' }}>
                  <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'var(--studio-accent)' }} />
                  <Typography fontSize={13} color="text.secondary">
                    {item}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
          <Stack direction="row" gap={1}>
            <Button fullWidth variant="outlined" disabled={busy} onClick={() => onAction('run')}>
              运行
            </Button>
            <Button fullWidth variant="outlined" disabled={busy} onClick={() => onAction('refresh')}>
              同步
            </Button>
          </Stack>
          <Divider />
          <Box>
            <Typography color="text.secondary" fontWeight={800} fontSize={12}>
              最近事件
            </Typography>
            <Stack gap={0.8} sx={{ mt: 1 }}>
              {events.slice(0, 4).map((event) => (
                <Box key={event.id} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'var(--studio-bg)' }}>
                  <Typography fontSize={13} fontWeight={800}>
                    {event.summary}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    {new Date(event.createdAt).toLocaleString()}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        </Stack>
      ) : (
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          选择一项查看详情。
        </Typography>
      )}
    </Paper>
  )
}

function GridRow({
  cells,
  row,
  muted,
  active,
  onClick,
}: {
  cells: readonly string[]
  row?: StudioRow
  muted?: boolean
  active?: boolean
  onClick?: () => void
}) {
  return (
    <Box
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      sx={{
        display: 'grid',
        gridTemplateColumns: '1.25fr 1.2fr 1fr 0.78fr',
        gap: 1,
        px: 1.6,
        py: 1.15,
        alignItems: 'center',
        borderBottom: muted ? 0 : '1px solid var(--studio-border)',
        bgcolor: active ? 'var(--studio-accent-soft)' : undefined,
        cursor: onClick ? 'pointer' : 'default',
        '&:hover': muted ? undefined : { bgcolor: active ? 'var(--studio-accent-soft)' : 'var(--studio-surface-soft)' },
      }}
    >
      {cells.map((cell, index) => {
        if (!muted && index === 3) {
          return <Chip key={`${row?.id ?? cell}-${index}`} label={cell} size="small" color={statusColor(cell)} variant="outlined" />
        }
        return (
          <Typography
            key={`${cell}-${index}`}
            noWrap
            color={muted ? 'text.secondary' : index === 0 ? 'text.primary' : 'text.secondary'}
            fontWeight={muted || index === 0 ? 800 : 650}
            fontSize={muted ? 12 : 14}
          >
            {cell}
          </Typography>
        )
      })}
    </Box>
  )
}

function toneColor(tone: string) {
  if (tone === 'success') return 'success.main'
  if (tone === 'warning') return 'warning.main'
  if (tone === 'danger') return 'error.main'
  return 'text.secondary'
}

function statusColor(status: string): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (['在线', '成功', '通过'].includes(status)) return 'success'
  if (['运行中'].includes(status)) return 'primary'
  if (['草稿', '等待中', '需要授权', '只读', '关注', '待确认'].includes(status)) return 'warning'
  if (['失败', '退回'].includes(status)) return 'error'
  return 'default'
}
