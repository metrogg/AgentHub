export type RouteDecision = 'DirectReply' | 'OrchestratorPlan' | 'ConversationLoop' | 'NoOrchestrator'

export interface RouteResult {
  decision: RouteDecision
  reason: string
}

export enum ComplexityLevel {
  SIMPLE = 'SIMPLE',
  MODERATE = 'MODERATE',
  COMPLEX = 'COMPLEX',
}

export class IntentRouter {
  private defaultSignalsThreshold: number

  constructor(signalsThreshold?: number) {
    this.defaultSignalsThreshold = signalsThreshold ?? 3
  }

  route(params: {
    content: string
    hasOrchestrator: boolean
    mentionCount: number
    workspaceOverrides?: { signalsThreshold?: number }
  }): RouteResult {
    const { content, hasOrchestrator, mentionCount, workspaceOverrides } = params
    const threshold = workspaceOverrides?.signalsThreshold ?? this.defaultSignalsThreshold

    if (mentionCount > 0) {
      return { decision: 'DirectReply', reason: '用户 @了特定 Agent' }
    }

    if (!hasOrchestrator) {
      return { decision: 'NoOrchestrator', reason: '群聊中未配置 Orchestrator' }
    }

    if (this.hasOrchestratorSignals(content, threshold)) {
      return { decision: 'OrchestratorPlan', reason: '检测到复杂任务，生成编排计划' }
    }

    return { decision: 'ConversationLoop', reason: 'Orchestrator 直接回复' }
  }

  hasOrchestratorSignals(content: string, threshold?: number): boolean {
    const lower = content.toLowerCase()
    let signals = 0

    const fileRefs = content.match(
      /[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|vue|css|scss|html|sql|json|yaml|yml|toml|md)\b/gi,
    )
    if (fileRefs && new Set(fileRefs.map((f) => f.toLowerCase())).size >= 2) signals += 2

    const phasePatterns = [
      /先.{2,20}然后/,
      /先.{2,20}再/,
      /第[一二三四五六七八九十\d]步/,
      /step\s*\d/i,
      /first.{5,30}then/i,
      /首先.{2,20}接着/,
      /\d+\.\s+\S.{3,}/m,
    ]
    if (phasePatterns.some((p) => p.test(content))) signals += 2

    const archKeywords = [
      '架构','重构','系统设计','整体','全流程','端到端','从零开始',
      'architecture','refactor','system design','end-to-end','full stack','fullstack',
      '全栈','迁移','migration',
    ]
    if (archKeywords.some((k) => lower.includes(k))) signals += 2

    const collabKeywords = [
      '同时','并行','一起','分别','各自','协作',
      'simultaneously','in parallel','together','respectively',
    ]
    if (collabKeywords.some((k) => lower.includes(k))) signals += 1

    const complexVerbs = [
      '实现','创建','搭建','开发','构建','设计','制作','做一个','生成',
      'implement','create','build','develop','design','make','generate',
    ]
    const techObjects = [
      'api','ui','数据库','database','认证','auth','组件','component','服务',
      'service','模块','module','页面','page','网站','网页','webapp','web app','site','website',
      '游戏','小游戏','game','应用','app','工具','tool',
    ]
    const hasComplexVerb = complexVerbs.some((v) => lower.includes(v))
    const hasTechObject = techObjects.some((t) => lower.includes(t))
    if (hasComplexVerb && hasTechObject) signals += 1
    if (hasWorkRequestSignal(lower)) signals += 3
    if (hasConcreteBuildRequestSignal(lower)) signals += 3
    if (
      hasComplexVerb &&
      ['官网','网站','网页','webapp','web app','site','website','游戏','小游戏','game','应用','app'].some((t) =>
        lower.includes(t),
      )
    )
      signals += 2

    if (content.length > 200 && techObjects.some((t) => lower.includes(t))) signals += 1

    return signals >= (threshold ?? this.defaultSignalsThreshold)
  }

  assessComplexity(content: string): ComplexityLevel {
    const lower = content.toLowerCase()

    const directExecutionKeywords = ['just do it', '直接做', '直接执行', '无需计划', '不用确认']
    if (directExecutionKeywords.some((k) => lower.includes(k)) && content.length < 80) {
      return ComplexityLevel.SIMPLE
    }

    const complexKeywords = [
      'multiple', 'system', 'auth', 'authentication', 'database',
      '微服务', '系统', '用户管理', '架构', '多页面', 'full stack', 'fullstack',
      '网站', '网页', '游戏', '小游戏', '应用', 'app', 'webapp', 'website', 'game',
    ]
    if (complexKeywords.some((k) => lower.includes(k))) {
      return ComplexityLevel.COMPLEX
    }

    return ComplexityLevel.MODERATE
  }
}

export const intentRouter = new IntentRouter()

function hasWorkRequestSignal(lower: string): boolean {
  const workVerbs = [
    '开发',
    '搭建',
    '构建',
    '创建',
    '制作',
    '设计',
    '实现',
    '生成',
    '输出',
    '调研',
    '分析',
    '整理',
    '撰写',
    '写一份',
    '写个',
    '做一个',
    '做个',
    'build',
    'create',
    'develop',
    'design',
    'implement',
    'generate',
    'research',
    'analyze',
  ]
  const deliverables = [
    '官网',
    '网站',
    '网页',
    '页面',
    'html',
    'pdf',
    '文档',
    '报告',
    'ppt',
    '幻灯片',
    '应用',
    'app',
    '工具',
    '游戏',
    '原型',
    'demo',
    'website',
    'web page',
    'document',
    'report',
  ]
  return workVerbs.some((verb) => lower.includes(verb)) &&
    deliverables.some((item) => lower.includes(item))
}

function hasConcreteBuildRequestSignal(lower: string): boolean {
  const buildPhrases = [
    '开发一个',
    '开发个',
    '做一个',
    '做个',
    '写一个',
    '写个',
    '实现一个',
    '实现个',
    '创建一个',
    '创建个',
    '搭建一个',
    '搭建个',
    'build a',
    'create a',
    'make a',
    'implement a',
  ]
  if (!buildPhrases.some((phrase) => lower.includes(phrase))) return false
  const casualQuestionHints = ['吗', '么', '如何', '怎么', '?', '？']
  if (casualQuestionHints.some((hint) => lower.includes(hint)) && lower.length < 28) return false
  return lower.trim().length >= 6
}
