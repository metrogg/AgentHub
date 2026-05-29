export type DemoArtifact =
  | {
      id: string
      kind: 'web_preview'
      type: 'preview'
      title: string
      description: string
      url: string
      previewKind: 'dev-server' | 'static-html' | 'iframe'
      status: 'ready' | 'building' | 'failed'
    }
  | {
      id: string
      kind: 'diff'
      type: 'diff'
      title: string
      description: string
      filePath: string
      language: string
      diff: string
    }
  | {
      id: string
      kind: 'file'
      type: 'file'
      title: string
      description: string
      path: string
      mimeType: string
      size: number
      url: string
    }
  | {
      id: string
      kind: 'deploy'
      type: 'deploy'
      title: string
      description: string
      provider: string
      status: 'pending' | 'running' | 'ready' | 'failed'
      url: string
      logs: string[]
    }
  | {
      id: string
      kind: 'workflow'
      type: 'workflow'
      title: string
      description: string
      nodes: Array<{
        id: string
        label: string
        type: 'agent' | 'tool' | 'input' | 'output'
        agentKey?: string
        agentName?: string
        agentColor?: string
      }>
      edges: Array<{ from: string; to: string; label?: string }>
    }

export function buildDemoArtifacts(content: string): DemoArtifact[] {
  const lower = content.toLowerCase()
  const artifacts: DemoArtifact[] = []
  const wantsDeploy = /部署|发布|deploy|release/.test(lower)
  const wantsPreview = /预览|preview|网页|页面|web/.test(lower)
  const wantsDiff = /diff|补丁|变更|修改|应用/.test(lower)
  const wantsFile = /文件|附件|下载|打包|源码|zip|ppt|文档/.test(lower)
  const wantsWorkflow = /workflow|工作流|流程|编排|pipeline/.test(lower)

  if (wantsWorkflow) {
    artifacts.push({
      id: `workflow-${crypto.randomUUID()}`,
      kind: 'workflow',
      type: 'workflow',
      title: 'Agent 协作 Workflow',
      description: '多 Agent 协作工作流定义，可在聊天流中可视化预览并一键执行。',
      nodes: [
        { id: 'input', label: '用户输入', type: 'input' },
        { id: 'orchestrator', label: '总指挥', type: 'agent', agentKey: 'orchestrator', agentName: 'Orchestrator', agentColor: '#7c3aed' },
        { id: 'coder', label: '实现者', type: 'agent', agentKey: 'coder', agentName: 'Coder', agentColor: '#10b981' },
        { id: 'reviewer', label: '审查者', type: 'agent', agentKey: 'reviewer', agentName: 'Reviewer', agentColor: '#ef4444' },
        { id: 'output', label: '产出汇总', type: 'output' },
      ],
      edges: [
        { from: 'input', to: 'orchestrator', label: '拆解' },
        { from: 'orchestrator', to: 'coder', label: '实现' },
        { from: 'coder', to: 'reviewer', label: '审查' },
        { from: 'reviewer', to: 'output', label: '汇总' },
      ],
    })
  }

  if (wantsPreview || (!wantsDeploy && !wantsDiff && !wantsFile && !wantsWorkflow)) {
    artifacts.push({
      id: `web-${crypto.randomUUID()}`,
      kind: 'web_preview',
      type: 'preview',
      title: 'AgentHub Web Preview',
      description: '聊天流内联网页预览，可展开后接入 iframe、Sandpack 或真实预览 URL。',
      url: 'https://agenthub.local/preview/landing-page',
      previewKind: 'iframe',
      status: 'ready',
    })
  }

  if (wantsDiff) {
    artifacts.push({
      id: `diff-${crypto.randomUUID()}`,
      kind: 'diff',
      type: 'diff',
      title: 'UI 变更 Diff',
      description: '展示 Agent 产出的代码补丁，后续可接"一键应用 Diff"。',
      filePath: 'apps/web/src/components/chat/SessionList.tsx',
      language: 'tsx',
      diff: [
        'diff --git a/apps/web/src/components/chat/SessionList.tsx b/apps/web/src/components/chat/SessionList.tsx',
        'index 1234567..abcdefg 100644',
        '--- a/apps/web/src/components/chat/SessionList.tsx',
        '+++ b/apps/web/src/components/chat/SessionList.tsx',
        '@@ -42,7 +42,11 @@ export default function SessionList() {',
        '-  const sessionTree = useMemo(() => buildSessionTree(sessions), [sessions])',
        '+  const [query, setQuery] = useState("")',
        '+  const [showArchived, setShowArchived] = useState(false)',
        '+  const sessionTree = useMemo(',
        '+    () => filterSessionTree(buildSessionTree(sessions), query, showArchived),',
        '+    [query, sessions, showArchived]',
        '+  )',
      ].join('\n'),
    })
  }

  if (wantsDeploy) {
    artifacts.push({
      id: `deploy-${crypto.randomUUID()}`,
      kind: 'deploy',
      type: 'deploy',
      title: '静态站点部署',
      description: '部署状态卡片先以 Demo 方式闭环，真实版本可接 Vercel、Netlify 或容器平台。',
      provider: 'static',
      status: 'ready',
      url: 'https://agenthub-preview.local/app',
      logs: ['Build queued', 'Install dependencies', 'Run production build', 'Upload static assets', 'Preview is ready'],
    })
  }

  if (wantsFile) {
    artifacts.push({
      id: `file-${crypto.randomUUID()}`,
      kind: 'file',
      type: 'file',
      title: '源码打包附件',
      description: '用于展示 Agent 回复中的文件附件入口。',
      path: 'agenthub-preview-source.zip',
      mimeType: 'application/zip',
      size: 131072,
      url: '#',
    })
  }

  return artifacts.length ? artifacts : buildDemoArtifacts('预览')
}

export function artifactSummary(artifacts: DemoArtifact[]) {
  const labels = artifacts.map((artifact) => {
    if (artifact.type === 'preview') return '网页预览'
    if (artifact.type === 'diff') return 'Diff 视图'
    if (artifact.type === 'deploy') return '部署状态'
    if (artifact.type === 'workflow') return 'Workflow'
    return '文件附件'
  })
  return `已生成 ${labels.join('、')} 卡片，可在聊天流中直接预览和操作。`
}
