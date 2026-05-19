import { Alert, Box, Button, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import ApiIcon from '@mui/icons-material/Api'
import AutoGraphIcon from '@mui/icons-material/AutoGraph'
import DatasetIcon from '@mui/icons-material/Dataset'
import HistoryIcon from '@mui/icons-material/History'
import HubIcon from '@mui/icons-material/Hub'
import MemoryIcon from '@mui/icons-material/Memory'
import PsychologyAltIcon from '@mui/icons-material/PsychologyAlt'
import ScienceIcon from '@mui/icons-material/Science'
import VisibilityIcon from '@mui/icons-material/Visibility'

interface StudioHomeProps {
  onNewSession: () => void
  isLoading: boolean
  error: string | null
}

const studioPillars = [
  {
    title: '观测',
    body: '查看 Agent 运行、流式事件、追踪、Token 用量和工作流步骤状态。',
    icon: <VisibilityIcon />,
  },
  {
    title: '迭代',
    body: '调试提示词、模型设置、工具、工作流、记忆和审批策略。',
    icon: <AutoGraphIcon />,
  },
  {
    title: '协作',
    body: '把聊天过程变成可审查的 Agent 工作记录，并沉淀数据集与可发布版本。',
    icon: <HubIcon />,
  },
]

const entities = [
  ['智能体', 'Supervisor 与专家 Agent 注册表', <PsychologyAltIcon />],
  ['工作流', '确定性步骤图与可恢复运行', <AccountTreeIcon />],
  ['工具', '工具注册、权限范围、审批与 MCP 接入', <ApiIcon />],
  ['记忆', '会话摘要与子 Agent 记忆隔离', <MemoryIcon />],
  ['追踪', '运行时间线、Span、延迟与 Token 用量', <HistoryIcon />],
  ['评测', '评分器、数据集与审查闭环', <ScienceIcon />],
]

const workflowSteps = [
  ['提示', '捕获用户目标与约束条件'],
  ['路由', 'Supervisor 选择 Agent 或工作流'],
  ['执行', '工具、记忆和子 Agent 协同运行'],
  ['审查', '追踪、评分并持久化运行结果'],
]

export default function StudioHome({ onNewSession, isLoading, error }: StudioHomeProps) {
  return (
    <Paper
      elevation={0}
      sx={{
        height: '100%',
        minHeight: 0,
        overflow: 'auto',
        border: '1px solid rgba(32,28,24,0.12)',
        bgcolor: 'background.paper',
        boxShadow: '0 22px 70px rgba(32,28,24,0.08)',
      }}
    >
      <Box sx={{ p: { xs: 2.5, md: 4 }, maxWidth: 1180, mx: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: '1.05fr 0.95fr' },
            gap: 3,
            alignItems: 'stretch',
          }}
        >
          <Box>
            <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 900 }}>
              AgentHub 工作室
            </Typography>
            <Typography variant="h4" sx={{ mt: 0.5, mb: 1, fontWeight: 900 }}>
              构建、测试并观测 Mastra 风格的智能体
            </Typography>
            <Typography color="text.secondary" sx={{ maxWidth: 680, lineHeight: 1.7 }}>
              工作室参考 Mastra Playground 的组织方式：聊天是测试台，智能体、工具、工作流、记忆、追踪和评测作为一等运行对象持续可见。
            </Typography>

            {error && (
              <Alert severity="warning" sx={{ mt: 2.5 }}>
                无法连接 AgentHub API。请检查 VITE_API_URL 和后端服务端口。
              </Alert>
            )}

            <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2.5 }}>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={onNewSession}
                disabled={isLoading}
              >
                新建运行
              </Button>
              <Chip label="本地工作室" />
              <Chip label="Mastra 运行时" color="primary" variant="outlined" />
            </Stack>
          </Box>

          <Paper
            elevation={0}
            sx={{
              p: 2.5,
              bgcolor: '#201c18',
              color: '#fff8ec',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 2 }}>
              <DatasetIcon sx={{ color: '#f2c46d' }} />
              <Box>
                <Typography fontWeight={900}>工作室就绪度</Typography>
                <Typography variant="body2" sx={{ color: 'rgba(255,248,236,0.66)' }}>
                  当前先完成设计，再逐步接入真实 Mastra 数据。
                </Typography>
              </Box>
            </Stack>
            <Readiness label="Agent 注册表" value={62} />
            <Readiness label="工作流图谱" value={48} />
            <Readiness label="可观测性" value={35} />
            <Readiness label="评测闭环" value={22} />
          </Paper>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, 1fr)' },
            gap: 1.5,
            mt: 3,
          }}
        >
          {studioPillars.map((item) => (
            <StudioCard key={item.title} title={item.title} icon={item.icon}>
              {item.body}
            </StudioCard>
          ))}
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: '1fr 360px' },
            gap: 2,
            mt: 2,
          }}
        >
          <Paper
            elevation={0}
            sx={{ p: 2, border: '1px solid rgba(32,28,24,0.1)', bgcolor: '#f9f3e8' }}
          >
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              工作室实体
            </Typography>
            <Box
              sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}
            >
              {entities.map(([title, body, icon]) => (
                <EntityTile
                  key={title as string}
                  title={title as string}
                  icon={icon as React.ReactElement}
                >
                  {body}
                </EntityTile>
              ))}
            </Box>
          </Paper>

          <Paper
            elevation={0}
            sx={{ p: 2, border: '1px solid rgba(32,28,24,0.1)', bgcolor: '#fffcf5' }}
          >
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              运行生命周期
            </Typography>
            <Stack gap={1.2}>
              {workflowSteps.map(([title, body], index) => (
                <Box key={title} sx={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 1 }}>
                  <Box
                    sx={{
                      width: 32,
                      height: 32,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 1.5,
                      bgcolor: index === 0 ? 'primary.main' : 'rgba(32,28,24,0.08)',
                      color: index === 0 ? '#fff8ec' : 'text.secondary',
                      fontWeight: 900,
                    }}
                  >
                    {index + 1}
                  </Box>
                  <Box>
                    <Typography fontWeight={900}>{title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {body}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          </Paper>
        </Box>
      </Box>
    </Paper>
  )
}

function StudioCard({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactElement
  children: React.ReactNode
}) {
  return (
    <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(32,28,24,0.1)', bgcolor: '#fffcf5' }}>
      <Box sx={{ color: 'primary.main', mb: 1 }}>{icon}</Box>
      <Typography fontWeight={900}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, lineHeight: 1.55 }}>
        {children}
      </Typography>
    </Paper>
  )
}

function EntityTile({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactElement
  children: React.ReactNode
}) {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 2,
        bgcolor: '#fffcf5',
        border: '1px solid rgba(32,28,24,0.08)',
      }}
    >
      <Stack direction="row" gap={1} alignItems="center">
        <Box sx={{ color: 'primary.main', display: 'grid', placeItems: 'center' }}>{icon}</Box>
        <Typography fontWeight={900}>{title}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
        {children}
      </Typography>
    </Box>
  )
}

function Readiness({ label, value }: { label: string; value: number }) {
  return (
    <Box sx={{ mb: 1.4 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography variant="body2" fontWeight={900}>
          {label}
        </Typography>
        <Typography variant="body2" sx={{ color: 'rgba(255,248,236,0.66)' }}>
          {value}%
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={value}
        sx={{
          height: 8,
          borderRadius: 4,
          bgcolor: 'rgba(255,248,236,0.12)',
          '& .MuiLinearProgress-bar': { bgcolor: '#f2c46d' },
        }}
      />
    </Box>
  )
}
