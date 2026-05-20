import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ArticleIcon from '@mui/icons-material/Article'
import ChatIcon from '@mui/icons-material/Chat'
import CodeIcon from '@mui/icons-material/Code'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MemoryIcon from '@mui/icons-material/Memory'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RateReviewIcon from '@mui/icons-material/RateReview'
import SaveIcon from '@mui/icons-material/Save'
import ScienceIcon from '@mui/icons-material/Science'
import TimelineIcon from '@mui/icons-material/Timeline'
import { useParams } from 'react-router-dom'
import AgentConsolePanel from '../features/agent/AgentConsolePanel'
import ChatContainer from '../features/chat/ChatContainer'
import type { ChatMessage } from '../features/chat/MessageList'
import { fetchMessages, sendMessage as apiSendMessage } from '../api/messages'
import {
  fetchAgentStudio,
  runAgentEvaluation,
  saveAgentStudio,
  updateAgentReview,
  type StudioAgent,
  type StudioEvaluationResult,
  type StudioReviewItem,
} from '../api/studio'
import { getApiBaseURL } from '../api/client'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSessionStore } from '../stores/sessionStore'

type AgentTab = 'chat' | 'editor' | 'evaluate' | 'review' | 'traces' | 'memory'

const defaultAgentName = 'Weather Agent'

export default function ChatPage() {
  const { agentId = 'weather-agent' } = useParams()
  const { sessions, currentSessionId, createSession, setCurrentSession } = useSessionStore()
  const [agent, setAgent] = useState<StudioAgent | null>(null)
  const [activeTab, setActiveTab] = useState<AgentTab>('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [wsUrl, setWsUrl] = useState(defaultWsUrl())
  const streamingContent = useRef<Record<string, string>>({})
  const streamingIdRef = useRef<string | null>(null)

  const { sendMessage, subscribe, readyState } = useWebSocket(wsUrl)

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId),
    [currentSessionId, sessions],
  )

  useEffect(() => {
    getApiBaseURL()
      .then((baseURL) => setWsUrl(baseURL.replace(/^http/, 'ws')))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchAgentStudio(agentId)
      .then((data) => {
        if (!cancelled) setAgent(data)
      })
      .catch(() => {
        if (!cancelled) setAgent(null)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleNewSession = useCallback(async () => {
    await createSession(`新对话 ${new Date().toLocaleTimeString()}`)
  }, [createSession])

  useEffect(() => {
    if (!currentSessionId || readyState !== WebSocket.OPEN) return
    sendMessage({ type: 'session:join', payload: { sessionId: currentSessionId } })
  }, [currentSessionId, readyState, sendMessage])

  useEffect(() => {
    if (!currentSessionId) {
      setMessages([])
      return
    }
    setIsLoading(true)
    fetchMessages(currentSessionId)
      .then((items) => setMessages(items))
      .finally(() => setIsLoading(false))
  }, [currentSessionId])

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type === 'message:stream' && event.payload.messageId) {
        const msgId = event.payload.messageId as string
        const delta = (event.payload.delta as string) ?? ''
        streamingIdRef.current = msgId
        setStreamingId(msgId)
        streamingContent.current[msgId] = (streamingContent.current[msgId] ?? '') + delta
        setMessages((prev) => {
          const exists = prev.find((m) => m.id === msgId)
          if (exists) {
            return prev.map((m) => (m.id === msgId ? { ...m, content: streamingContent.current[msgId] } : m))
          }
          return [
            ...prev,
            {
              id: msgId,
              senderType: 'agent',
              content: streamingContent.current[msgId],
              createdAt: new Date().toISOString(),
            },
          ]
        })
      }

      if (event.type === 'message:completed' && event.payload.message) {
        const msg = event.payload.message as ChatMessage
        const activeStreamId = streamingIdRef.current
        streamingIdRef.current = null
        setStreamingId(null)
        if (activeStreamId) delete streamingContent.current[activeStreamId]
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== msg.id && m.id !== activeStreamId)
          return [...filtered, msg]
        })
      }
    })
    return () => unsubscribe()
  }, [subscribe])

  const handleSend = useCallback(
    async (content: string) => {
      let sessionId = currentSessionId
      if (!sessionId) {
        const session = await createSession(`新对话 ${new Date().toLocaleTimeString()}`)
        if (!session) return
        sessionId = session.id
      }

      setIsLoading(true)
      try {
        const msg = await apiSendMessage(sessionId, content)
        setMessages((prev) => [...prev, msg as ChatMessage])
      } finally {
        setIsLoading(false)
      }
    },
    [createSession, currentSessionId],
  )

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'grid', gridTemplateRows: '42px 1fr' }}>
      <StudioHeader agent={agent} agentId={agentId} />
      <Paper
        elevation={0}
        sx={{
          minHeight: 0,
          display: 'grid',
          gridTemplateRows: '48px 1fr',
          overflow: 'hidden',
          bgcolor: 'background.paper',
          border: '1px solid var(--studio-border)',
          borderRadius: 3,
        }}
      >
        <AgentTabs value={activeTab} onChange={setActiveTab} />
        {activeTab === 'chat' ? (
          <Box
            sx={{
              minHeight: 0,
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: '200px minmax(0, 1fr) 360px' },
            }}
          >
            <ThreadRail
              sessions={sessions}
              currentSessionId={currentSessionId}
              onNewSession={handleNewSession}
              onSelect={setCurrentSession}
            />
            <ChatContainer
              title={currentSession?.title ?? agent?.name ?? defaultAgentName}
              messages={messages}
              streamingMessageId={streamingId}
              onSend={handleSend}
              onNewSession={handleNewSession}
              isLoading={isLoading}
              socketState={readyState}
            />
            <AgentConsolePanel
              agent={agent ?? undefined}
              messageCount={messages.length}
              isStreaming={Boolean(streamingId)}
              socketState={readyState}
            />
          </Box>
        ) : (
          <AgentTabPanel tab={activeTab} agent={agent} agentId={agentId} onAgentChange={setAgent} />
        )}
      </Paper>
    </Box>
  )
}

function StudioHeader({ agent, agentId }: { agent: StudioAgent | null; agentId: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 0.5 }}>
      <Stack direction="row" alignItems="center" gap={1.2}>
        <Link href="/agents" underline="none" color="text.secondary" sx={{ fontWeight: 700, fontSize: 14 }}>
          智能体
        </Link>
        <Typography color="text.disabled">/</Typography>
        <Button size="small" endIcon={<ExpandMoreIcon />} sx={{ color: 'text.primary', px: 1 }}>
          {agent?.name ?? agentId}
        </Button>
      </Stack>
      <Button
        size="small"
        startIcon={<ArticleIcon />}
        href="https://mastra.ai/en/docs/agents/overview"
        target="_blank"
        sx={{ color: 'text.secondary', display: { xs: 'none', md: 'inline-flex' } }}
      >
        智能体文档
      </Button>
    </Box>
  )
}

function AgentTabs({ value, onChange }: { value: AgentTab; onChange: (value: AgentTab) => void }) {
  return (
    <Tabs
      value={value}
      onChange={(_, next: AgentTab) => onChange(next)}
      variant="scrollable"
      scrollButtons={false}
      sx={{
        px: 1.5,
        minHeight: 48,
        borderBottom: '1px solid var(--studio-border)',
        '& .MuiTab-root': { minHeight: 48, px: 1.6, color: 'text.secondary', fontWeight: 700 },
        '& .Mui-selected': { color: 'text.primary' },
        '& .MuiTabs-indicator': { bgcolor: 'text.primary' },
      }}
    >
      <Tab value="chat" icon={<ChatIcon />} iconPosition="start" label="聊天" />
      <Tab value="editor" icon={<CodeIcon />} iconPosition="start" label="编辑器" />
      <Tab value="evaluate" icon={<ScienceIcon />} iconPosition="start" label="评估" />
      <Tab value="review" icon={<RateReviewIcon />} iconPosition="start" label="审查" />
      <Tab value="traces" icon={<TimelineIcon />} iconPosition="start" label="追踪" />
      <Tab value="memory" icon={<MemoryIcon />} iconPosition="start" label="记忆" />
    </Tabs>
  )
}

function AgentTabPanel({
  tab,
  agent,
  agentId,
  onAgentChange,
}: {
  tab: AgentTab
  agent: StudioAgent | null
  agentId: string
  onAgentChange: (agent: StudioAgent) => void
}) {
  if (!agent) {
    return (
      <StudioPanel title="正在载入" subtitle="正在连接 AgentHub Studio API。">
        <Typography color="text.secondary">请稍候。</Typography>
      </StudioPanel>
    )
  }

  if (tab === 'editor') return <EditorPanel agent={agent} onAgentChange={onAgentChange} />
  if (tab === 'evaluate') return <EvaluatePanel agent={agent} agentId={agentId} onAgentChange={onAgentChange} />
  if (tab === 'review') return <ReviewPanel agent={agent} agentId={agentId} onAgentChange={onAgentChange} />
  if (tab === 'memory') return <MemoryPanel agent={agent} onAgentChange={onAgentChange} />
  return <TracesPanel agent={agent} />
}

function EditorPanel({ agent, onAgentChange }: { agent: StudioAgent; onAgentChange: (agent: StudioAgent) => void }) {
  const [draft, setDraft] = useState({
    name: agent.name,
    model: agent.model,
    provider: agent.provider,
    temperature: String(agent.temperature),
    maxSteps: String(agent.maxSteps),
    prompt: agent.prompt,
    tools: agent.tools.join(', '),
    workflows: agent.workflows.join(', '),
    processors: agent.processors.join(', '),
    scorers: agent.scorers.join(', '),
    memoryEnabled: agent.memoryEnabled,
    tracingEnabled: agent.tracingEnabled,
  })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setDraft({
      name: agent.name,
      model: agent.model,
      provider: agent.provider,
      temperature: String(agent.temperature),
      maxSteps: String(agent.maxSteps),
      prompt: agent.prompt,
      tools: agent.tools.join(', '),
      workflows: agent.workflows.join(', '),
      processors: agent.processors.join(', '),
      scorers: agent.scorers.join(', '),
      memoryEnabled: agent.memoryEnabled,
      tracingEnabled: agent.tracingEnabled,
    })
  }, [agent])

  const handleSave = async () => {
    const updated = await saveAgentStudio(agent.id, {
      name: draft.name,
      model: draft.model,
      provider: draft.provider,
      temperature: Number(draft.temperature),
      maxSteps: Number(draft.maxSteps),
      prompt: draft.prompt,
      tools: splitList(draft.tools),
      workflows: splitList(draft.workflows),
      processors: splitList(draft.processors),
      scorers: splitList(draft.scorers),
      memoryEnabled: draft.memoryEnabled,
      tracingEnabled: draft.tracingEnabled,
    })
    onAgentChange(updated)
    setNotice('Agent 配置已保存。')
  }

  return (
    <StudioPanel title="Agent 编辑器" subtitle="模型、系统提示词、工具、工作流、处理器、评分器和观测配置。">
      <Stack gap={2}>
        {notice && <Chip color="success" variant="outlined" label={notice} sx={{ width: 'fit-content' }} />}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '420px 1fr' }, gap: 2 }}>
          <Stack gap={1.4}>
            <TextField label="Agent ID" value={agent.id} size="small" disabled />
            <TextField label="名称" value={draft.name} size="small" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <TextField select label="模型供应商" value={draft.provider} size="small" onChange={(event) => setDraft({ ...draft, provider: event.target.value })}>
              <MenuItem value="anthropic">Anthropic</MenuItem>
              <MenuItem value="openai">OpenAI</MenuItem>
              <MenuItem value="google">Google</MenuItem>
            </TextField>
            <TextField select label="模型" value={draft.model} size="small" onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
              <MenuItem value="claude-sonnet-4-6">claude-sonnet-4-6</MenuItem>
              <MenuItem value="claude-haiku-4-5">claude-haiku-4-5</MenuItem>
              <MenuItem value="claude-opus-4-1">claude-opus-4-1</MenuItem>
            </TextField>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              <TextField label="温度" value={draft.temperature} size="small" onChange={(event) => setDraft({ ...draft, temperature: event.target.value })} />
              <TextField label="最大步骤" value={draft.maxSteps} size="small" onChange={(event) => setDraft({ ...draft, maxSteps: event.target.value })} />
            </Box>
            <TextField label="工具" value={draft.tools} size="small" onChange={(event) => setDraft({ ...draft, tools: event.target.value })} />
            <TextField label="工作流" value={draft.workflows} size="small" onChange={(event) => setDraft({ ...draft, workflows: event.target.value })} />
            <TextField label="处理器" value={draft.processors} size="small" onChange={(event) => setDraft({ ...draft, processors: event.target.value })} />
            <TextField label="评分器" value={draft.scorers} size="small" onChange={(event) => setDraft({ ...draft, scorers: event.target.value })} />
            <Stack direction="row" gap={2} flexWrap="wrap">
              <FormControlLabel
                control={<Switch checked={draft.memoryEnabled} onChange={(event) => setDraft({ ...draft, memoryEnabled: event.target.checked })} />}
                label="记忆"
              />
              <FormControlLabel
                control={<Switch checked={draft.tracingEnabled} onChange={(event) => setDraft({ ...draft, tracingEnabled: event.target.checked })} />}
                label="追踪"
              />
            </Stack>
            <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSave}>
              保存 Agent
            </Button>
          </Stack>
          <TextField
            multiline
            minRows={18}
            label="System Prompt"
            value={draft.prompt}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />
        </Box>
      </Stack>
    </StudioPanel>
  )
}

function EvaluatePanel({
  agent,
  agentId,
  onAgentChange,
}: {
  agent: StudioAgent
  agentId: string
  onAgentChange: (agent: StudioAgent) => void
}) {
  const [dataset, setDataset] = useState(agent.datasets[0] ?? 'weather-basic')
  const [scorer, setScorer] = useState(agent.scorers[0] ?? 'answer-relevance')
  const [isRunning, setIsRunning] = useState(false)

  const handleRun = async () => {
    setIsRunning(true)
    try {
      const result = await runAgentEvaluation(agentId, dataset, scorer)
      onAgentChange({ ...agent, evaluations: [result, ...agent.evaluations] })
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <StudioPanel title="评估" subtitle="选择数据集和评分器，对当前 Agent 发起批量评估。">
      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 2 }}>
        <TextField select size="small" label="数据集" value={dataset} onChange={(event) => setDataset(event.target.value)} sx={{ minWidth: 220 }}>
          {agent.datasets.map((item) => (
            <MenuItem key={item} value={item}>
              {item}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="评分器" value={scorer} onChange={(event) => setScorer(event.target.value)} sx={{ minWidth: 220 }}>
          {agent.scorers.map((item) => (
            <MenuItem key={item} value={item}>
              {item}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="contained" startIcon={<PlayArrowIcon />} disabled={isRunning} onClick={handleRun}>
          运行评估
        </Button>
      </Stack>
      <ScoreGrid results={agent.evaluations} />
    </StudioPanel>
  )
}

function ReviewPanel({
  agent,
  agentId,
  onAgentChange,
}: {
  agent: StudioAgent
  agentId: string
  onAgentChange: (agent: StudioAgent) => void
}) {
  const handleUpdate = async (item: StudioReviewItem, status: StudioReviewItem['status']) => {
    const updated = await updateAgentReview(agentId, item.id, status)
    onAgentChange({
      ...agent,
      reviews: agent.reviews.map((review) => (review.id === updated.id ? updated : review)),
    })
  }

  return (
    <StudioPanel title="人工审查" subtitle="审查会话输出、工具调用、评分结果和需要确认的运行项。">
      <Stack gap={1}>
        {agent.reviews.map((item) => (
          <Paper key={item.id} sx={{ p: 1.5, bgcolor: 'var(--studio-surface)', border: '1px solid var(--studio-border)' }}>
            <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.2}>
              <Box>
                <Typography fontWeight={800}>{item.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {item.note}
                </Typography>
              </Box>
              <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                <Chip label={item.status} color={reviewColor(item.status)} variant="outlined" />
                <Button size="small" onClick={() => handleUpdate(item, '通过')}>
                  通过
                </Button>
                <Button size="small" color="warning" onClick={() => handleUpdate(item, '待确认')}>
                  待确认
                </Button>
                <Button size="small" color="error" onClick={() => handleUpdate(item, '退回')}>
                  退回
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </StudioPanel>
  )
}

function TracesPanel({ agent }: { agent: StudioAgent }) {
  return (
    <StudioPanel title="追踪" subtitle="查看当前 Agent 的运行时间线、Span、Token、输入输出和日志关联。">
      <Stack gap={1.2}>
        {agent.traces.map((row) => (
          <Box
            key={row.id}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1.3fr 0.7fr 0.6fr 0.7fr 1.4fr' },
              gap: 1,
              p: 1.3,
              borderRadius: 2,
              bgcolor: 'var(--studio-surface)',
              border: '1px solid var(--studio-border)',
            }}
          >
            <Typography fontWeight={800}>{row.span}</Typography>
            <Typography color={row.status === 'success' ? 'success.main' : 'text.secondary'} fontWeight={700}>
              {row.status}
            </Typography>
            <Typography color="text.secondary" fontWeight={700}>
              {row.latency}
            </Typography>
            <Typography color="text.secondary" fontWeight={700}>
              {row.tokens} tokens
            </Typography>
            <Typography color="text.secondary" noWrap>
              {row.output}
            </Typography>
          </Box>
        ))}
      </Stack>
    </StudioPanel>
  )
}

function MemoryPanel({ agent, onAgentChange }: { agent: StudioAgent; onAgentChange: (agent: StudioAgent) => void }) {
  const handleToggle = async (checked: boolean) => {
    const updated = await saveAgentStudio(agent.id, { memoryEnabled: checked })
    onAgentChange(updated)
  }

  return (
    <StudioPanel title="记忆" subtitle="查看线程、工作记忆和观测记忆状态。">
      <Stack gap={1.2}>
        <FormControlLabel
          control={<Switch checked={agent.memoryEnabled} onChange={(event) => handleToggle(event.target.checked)} />}
          label="启用记忆"
        />
        {agent.memoryThreads.map((thread) => (
          <Paper key={thread.id} sx={{ p: 1.5, bgcolor: 'var(--studio-surface)', border: '1px solid var(--studio-border)' }}>
            <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
              <Box>
                <Typography fontWeight={800}>{thread.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {thread.id}
                </Typography>
              </Box>
              <Stack direction="row" gap={1} alignItems="center">
                <Chip label={`${thread.messages} 条消息`} variant="outlined" />
                <Chip label={new Date(thread.updatedAt).toLocaleString()} variant="outlined" />
              </Stack>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </StudioPanel>
  )
}

function StudioPanel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Box sx={{ minHeight: 0, overflow: 'auto', p: 2.4 }}>
      <Typography variant="h5">{title}</Typography>
      <Typography color="text.secondary" sx={{ mt: 0.6, mb: 2.2 }}>
        {subtitle}
      </Typography>
      {children}
    </Box>
  )
}

function ScoreGrid({ results }: { results: StudioEvaluationResult[] }) {
  return (
    <Stack gap={1.2}>
      {results.map((result) => (
        <Paper key={result.id} sx={{ p: 1.6, bgcolor: 'var(--studio-surface)', border: '1px solid var(--studio-border)' }}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.2}>
            <Box>
              <Typography fontWeight={900}>
                {result.dataset} / {result.scorer}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {result.summary}
              </Typography>
            </Box>
            <Stack direction="row" gap={1} alignItems="center">
              <Typography variant="h5">{result.score.toFixed(2)}</Typography>
              <Chip label={result.status} color={result.status === '通过' ? 'success' : 'warning'} variant="outlined" />
            </Stack>
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}

function ThreadRail({
  sessions,
  currentSessionId,
  onNewSession,
  onSelect,
}: {
  sessions: Array<{ id: string; title: string; updatedAt: string }>
  currentSessionId: string | null
  onNewSession: () => void
  onSelect: (id: string) => void
}) {
  return (
    <Box
      sx={{
        display: { xs: 'none', lg: 'grid' },
        gridTemplateRows: 'auto 1fr',
        minHeight: 0,
        borderRight: '1px solid var(--studio-border)',
        bgcolor: 'var(--studio-surface)',
      }}
    >
      <Box sx={{ p: 1.4 }}>
        <Button
          startIcon={<AddIcon />}
          fullWidth
          onClick={onNewSession}
          sx={{
            justifyContent: 'flex-start',
            color: 'text.primary',
            bgcolor: 'var(--studio-bg)',
            border: '1px solid var(--studio-border)',
            '&:hover': { bgcolor: 'var(--studio-surface-soft)' },
          }}
        >
          新对话
        </Button>
      </Box>
      <Box sx={{ minHeight: 0, overflowY: 'auto', px: 1.2, pb: 1.2 }}>
        {sessions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.1, pt: 1.2, lineHeight: 1.65 }}>
            开始聊天后，会话会显示在这里。
          </Typography>
        ) : (
          <Stack gap={0.6}>
            {sessions.map((session) => (
              <Button
                key={session.id}
                onClick={() => onSelect(session.id)}
                fullWidth
                sx={{
                  justifyContent: 'flex-start',
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  px: 1.1,
                  py: 1,
                  color: session.id === currentSessionId ? 'text.primary' : 'text.secondary',
                  bgcolor: session.id === currentSessionId ? 'var(--studio-surface-soft)' : 'transparent',
                  '&:hover': { bgcolor: 'var(--studio-surface-soft)' },
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography noWrap fontWeight={760} fontSize={14}>
                    {session.title}
                  </Typography>
                  <Typography noWrap variant="caption" color="text.disabled">
                    {new Date(session.updatedAt).toLocaleString()}
                  </Typography>
                </Box>
              </Button>
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  )
}

function defaultWsUrl() {
  const raw = import.meta.env.VITE_API_URL ?? ''
  const base = raw.replace(/\/$/, '').replace(/\/api$/, '') || 'http://localhost:8000'
  return base.replace(/^http/, 'ws')
}

function splitList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function reviewColor(status: StudioReviewItem['status']) {
  if (status === '通过') return 'success'
  if (status === '退回') return 'error'
  return 'warning'
}
