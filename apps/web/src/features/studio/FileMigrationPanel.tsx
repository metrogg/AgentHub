import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  InputAdornment,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import FolderCopyIcon from '@mui/icons-material/FolderCopy'
import PreviewIcon from '@mui/icons-material/Preview'
import RefreshIcon from '@mui/icons-material/Refresh'
import SearchIcon from '@mui/icons-material/Search'
import {
  copyMigrationFiles,
  fetchMigrationFiles,
  fetchMigrationPreview,
  fetchMigrationRoots,
  type MigrationCopyResult,
  type MigrationFile,
  type MigrationPreview,
  type MigrationRoots,
} from '../../api/workspaceMigration'

export default function FileMigrationPanel() {
  const [roots, setRoots] = useState<MigrationRoots | null>(null)
  const [query, setQuery] = useState('packages/playground-ui/src')
  const [files, setFiles] = useState<MigrationFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [activePath, setActivePath] = useState<string>('')
  const [preview, setPreview] = useState<MigrationPreview | null>(null)
  const [targetOverrides, setTargetOverrides] = useState<Record<string, string>>({})
  const [overwrite, setOverwrite] = useState(false)
  const [results, setResults] = useState<MigrationCopyResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const selectedFiles = useMemo(
    () =>
      files
        .filter((file) => selected.has(file.path))
        .map((file) => ({
          sourcePath: file.path,
          targetPath: targetOverrides[file.path] || file.path,
        })),
    [files, selected, targetOverrides],
  )

  useEffect(() => {
    fetchMigrationRoots()
      .then(setRoots)
      .catch(() => setError('无法读取工作区根目录'))
  }, [])

  useEffect(() => {
    void loadFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activePath) {
      setPreview(null)
      return
    }
    fetchMigrationPreview(activePath)
      .then(setPreview)
      .catch(() => setPreview({ path: activePath, size: 0, content: '无法读取预览。' }))
  }, [activePath])

  const loadFiles = async () => {
    setIsLoading(true)
    setError('')
    try {
      const items = await fetchMigrationFiles(query)
      setFiles(items)
      setActivePath((current) => current || items[0]?.path || '')
    } catch {
      setError('无法扫描 mastra-main 文件。请确认后端服务已启动。')
    } finally {
      setIsLoading(false)
    }
  }

  const toggleSelected = (path: string) => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
    setActivePath(path)
  }

  const handleCopy = async () => {
    if (selectedFiles.length === 0) return
    setIsLoading(true)
    setError('')
    setResults([])
    try {
      const copyResults = await copyMigrationFiles(selectedFiles, overwrite)
      setResults(copyResults)
      await loadFiles()
    } catch {
      setError('迁移失败。请检查服务端日志或目标路径。')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Paper
      elevation={0}
      sx={{
        p: 2,
        mb: 2,
        bgcolor: '#111',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 2,
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2} sx={{ mb: 1.5 }}>
        <Box>
          <Typography variant="h6">文件迁移</Typography>
          <Typography color="text.secondary" sx={{ mt: 0.4 }}>
            从 Mastra 参考仓库挑选文件，预览后迁移到 AgentHub 工作区。
          </Typography>
        </Box>
        <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end">
          <Chip label={roots ? `源 ${shortPath(roots.sourceRoot)}` : '源目录'} variant="outlined" />
          <Chip label={roots ? `目标 ${shortPath(roots.targetRoot)}` : '目标目录'} variant="outlined" />
        </Stack>
      </Stack>

      {error && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          {error}
        </Alert>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1.5 }}>
        <TextField
          size="small"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索目录或文件"
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ minWidth: { xs: '100%', md: 360 } }}
        />
        <Button variant="outlined" startIcon={<RefreshIcon />} onClick={loadFiles} disabled={isLoading}>
          扫描
        </Button>
        <FormControlLabel
          control={<Switch checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />}
          label="允许覆盖"
        />
        <Button
          variant="contained"
          startIcon={<FolderCopyIcon />}
          onClick={handleCopy}
          disabled={isLoading || selectedFiles.length === 0}
        >
          迁移所选 {selectedFiles.length}
        </Button>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1fr) 420px' },
          gap: 1.5,
        }}
      >
        <Paper
          elevation={0}
          sx={{
            minHeight: 360,
            maxHeight: 520,
            overflow: 'auto',
            bgcolor: '#0b0b0b',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <FileHeader />
          <Divider />
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              active={activePath === file.path}
              selected={selected.has(file.path)}
              targetPath={targetOverrides[file.path] || file.path}
              onToggle={() => toggleSelected(file.path)}
              onFocus={() => setActivePath(file.path)}
              onTargetChange={(value) =>
                setTargetOverrides((current) => ({ ...current, [file.path]: value }))
              }
            />
          ))}
          {files.length === 0 && (
            <Typography color="text.secondary" sx={{ p: 2 }}>
              没有扫描到可迁移的文本文件。
            </Typography>
          )}
        </Paper>

        <Paper
          elevation={0}
          sx={{
            minHeight: 360,
            overflow: 'hidden',
            bgcolor: '#0b0b0b',
            border: '1px solid rgba(255,255,255,0.08)',
            display: 'grid',
            gridTemplateRows: 'auto 1fr',
          }}
        >
          <Stack direction="row" alignItems="center" gap={1} sx={{ px: 1.5, py: 1.2 }}>
            <PreviewIcon fontSize="small" />
            <Typography fontWeight={800} noWrap>
              {preview?.path || '选择文件查看预览'}
            </Typography>
          </Stack>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              overflow: 'auto',
              color: '#d7d7d7',
              fontFamily: '"Cascadia Code", Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.65,
              whiteSpace: 'pre-wrap',
            }}
          >
            {preview?.content || '暂无预览'}
          </Box>
        </Paper>
      </Box>

      {results.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography fontWeight={900} sx={{ mb: 1 }}>
            迁移结果
          </Typography>
          <Stack gap={0.7}>
            {results.map((result) => (
              <Chip
                key={`${result.sourcePath}:${result.targetPath}`}
                icon={<ContentCopyIcon />}
                label={`${result.status}: ${result.sourcePath} -> ${result.targetPath}${result.reason ? ` (${result.reason})` : ''}`}
                color={result.status === 'failed' ? 'error' : result.status === 'skipped' ? 'warning' : 'success'}
                variant="outlined"
                sx={{ justifyContent: 'flex-start', maxWidth: '100%' }}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  )
}

function FileHeader() {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '42px 1.2fr 1.2fr 90px',
        gap: 1,
        px: 1.2,
        py: 0.9,
      }}
    >
      {['', '源文件', '目标路径', '状态'].map((label) => (
        <Typography key={label} variant="caption" color="text.secondary" fontWeight={800}>
          {label}
        </Typography>
      ))}
    </Box>
  )
}

function FileRow({
  file,
  active,
  selected,
  targetPath,
  onToggle,
  onFocus,
  onTargetChange,
}: {
  file: MigrationFile
  active: boolean
  selected: boolean
  targetPath: string
  onToggle: () => void
  onFocus: () => void
  onTargetChange: (value: string) => void
}) {
  return (
    <Box
      onClick={onFocus}
      sx={{
        display: 'grid',
        gridTemplateColumns: '42px 1.2fr 1.2fr 90px',
        gap: 1,
        alignItems: 'center',
        px: 1.2,
        py: 0.8,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        bgcolor: active ? 'rgba(255,255,255,0.045)' : 'transparent',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
      }}
    >
      <Checkbox checked={selected} onChange={onToggle} onClick={(event) => event.stopPropagation()} />
      <Box sx={{ minWidth: 0 }}>
        <Typography noWrap fontWeight={800}>
          {file.path}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatBytes(file.size)} · {new Date(file.modifiedAt).toLocaleString()}
        </Typography>
      </Box>
      <TextField
        size="small"
        value={targetPath}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onTargetChange(event.target.value)}
      />
      <Chip
        size="small"
        label={file.targetExists ? '已存在' : '新增'}
        color={file.targetExists ? 'warning' : 'success'}
        variant="outlined"
      />
    </Box>
  )
}

function shortPath(value: string) {
  const parts = value.replace(/\\/g, '/').split('/')
  return parts.slice(-2).join('/')
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
