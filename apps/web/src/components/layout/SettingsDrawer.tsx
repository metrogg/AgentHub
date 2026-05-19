import { useState, useEffect } from 'react'
import {
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import KeyIcon from '@mui/icons-material/Key'
import { fetchSettings, saveSettings } from '../../api/settings'
import { useStudioTheme } from '../../theme/StudioThemeProvider'
import { studioThemeOptions, type StudioThemeId } from '../../theme/studioTheme'

interface Props {
  open: boolean
  onClose: () => void
}

export default function SettingsDrawer({ open, onClose }: Props) {
  const { themeId, setThemeId } = useStudioTheme()
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      fetchSettings()
        .then((data) => {
          setApiKey(data.ANTHROPIC_API_KEY ?? '')
          setModel(data.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6')
        })
        .catch(() => setError('无法加载设置'))
    }
  }, [open])

  const handleSave = async () => {
    setSaved(false)
    setError('')
    try {
      await saveSettings({
        ANTHROPIC_API_KEY: apiKey.trim(),
        ANTHROPIC_MODEL: model.trim(),
      })
      setSaved(true)
    } catch {
      setError('无法保存设置')
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 460 }, bgcolor: 'background.paper' } }}
    >
      <Box sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 900 }}>
              运行时
            </Typography>
            <Typography variant="h6">模型供应商设置</Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭设置">
            <CloseIcon />
          </IconButton>
        </Box>
        <Divider sx={{ mb: 3 }} />

        <Stack gap={2}>
          {saved && <Alert severity="success">设置已保存</Alert>}
          {error && <Alert severity="error">{error}</Alert>}

          <Box
            sx={{
              p: 2,
              bgcolor: 'var(--studio-surface)',
              border: '1px solid var(--studio-border)',
              borderRadius: 2,
            }}
          >
            <KeyIcon color="primary" sx={{ mb: 1 }} />
            <Typography fontWeight={900}>Mastra 模型适配器</Typography>
            <Typography variant="body2" color="text.secondary">
              这些值会存入服务端设置表，并在创建 Mastra Agent 时使用。
            </Typography>
          </Box>

          <TextField
            fullWidth
            label="Anthropic API Key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            size="small"
          />

          <TextField
            select
            fullWidth
            label="模型"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            size="small"
            helperText="填写供应商模型 ID。服务端会在需要时自动补充 anthropic/ 前缀。"
          >
            <MenuItem value="claude-sonnet-4-6">claude-sonnet-4-6</MenuItem>
            <MenuItem value="claude-opus-4-1">claude-opus-4-1</MenuItem>
            <MenuItem value="claude-haiku-4-5">claude-haiku-4-5</MenuItem>
          </TextField>

          <Divider />

          <Box>
            <Typography fontWeight={900} sx={{ mb: 0.5 }}>
              工作室主题
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.2 }}>
              主题会保存在本机，并立即应用到当前工作室。
            </Typography>
            <RadioGroup value={themeId} onChange={(event) => setThemeId(event.target.value as StudioThemeId)}>
              <Stack gap={1}>
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
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      gap: 1,
                      alignItems: 'center',
                      p: 1.2,
                      borderRadius: 2,
                      border: `1px solid ${themeId === option.id ? 'var(--studio-accent)' : 'var(--studio-border)'}`,
                      bgcolor: themeId === option.id ? 'var(--studio-accent-soft)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <FormControlLabel value={option.id} control={<Radio size="small" />} label="" sx={{ m: 0 }} />
                    <Box>
                      <Typography fontWeight={850}>{option.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {option.description}
                      </Typography>
                    </Box>
                    <Stack direction="row" gap={0.4}>
                      {option.swatches.map((color) => (
                        <Box
                          key={color}
                          sx={{
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            bgcolor: color,
                            border: '1px solid var(--studio-border)',
                          }}
                        />
                      ))}
                    </Stack>
                  </Box>
                ))}
              </Stack>
            </RadioGroup>
          </Box>

          <Button variant="contained" fullWidth onClick={handleSave}>
            保存设置
          </Button>
        </Stack>
      </Box>
    </Drawer>
  )
}
