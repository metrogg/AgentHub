import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import type { BlackboardEntry } from '../blackboard'
import type { ExecutionPlan, TaskResult } from './types'

export class Synthesizer {
  async synthesize(
    plan: ExecutionPlan,
    results: TaskResult[],
    conflictReports: Array<{ filePath: string; resolution: string; notes?: string }> = [],
    blackboardEntries: BlackboardEntry[] = [],
  ): Promise<string> {
    const sections = results
      .filter((r) => r.status === 'done')
      .map((r) => ({
        agent: r.agentName,
        task: r.taskId,
        output: r.output.slice(0, 3000),
        artifacts: r.artifacts,
      }))

    if (sections.length === 0) {
      return '**Orchestrator 汇总**\n\n所有子任务均未成功完成，请检查任务状态或重新派发。'
    }

    const system = `你是 AgentHub 的协调器。基于各子 Agent 的产出，生成一份统一的进展报告。

你必须严格使用以下固定结构输出（Markdown 格式，中文）：

## 执行摘要
用 2-3 句话概括整体进展、成功完成的任务数和关键成果。

## 各 Agent 产出
对每个成功的子任务，使用三级标题：
### {agentName} — {taskTitle}
- 核心产出摘要
- 关键文件/产物（如有）

## 冲突处理
如有代码冲突，列出每个文件的处理结果；如无冲突，写"无代码冲突"。

## 风险与建议
指出不一致、潜在风险或需要人工决策的地方；如没有，写"未发现明显风险"。

## 下一步行动
给出 1-3 条具体、可执行的后续建议。

注意事项：
1. 整合为连贯叙述，消除重复，统一术语
2. 明确标注各部分的贡献者
3. 使用 Markdown 格式，中文回复
4. 严禁省略任何一级标题
5. 如果存在失败任务，必须在「执行摘要」中明确指出失败数量和原因，严禁掩盖或编造成功信息`

    const conflictInfo = conflictReports.length
      ? `代码冲突情况：\n${conflictReports.map((c) => `- ${c.filePath}: ${c.resolution}${c.notes ? ` (${c.notes})` : ''}`).join('\n')}`
      : '无代码冲突。'

    const typedContext = formatTypedBlackboardEntries(blackboardEntries)

    const prompt = `
协作目标：${plan.goal}
任务总数：${results.length}
成功完成：${sections.length}
失败：${results.filter((r) => r.status === 'failed').length}

${conflictInfo}

结构化 Blackboard：
${typedContext}

各 Agent 当前最新产出：
${JSON.stringify(sections, null, 2)}

请生成汇总报告。
`

    try {
      let output = ''
      for await (const delta of streamReply([{ role: 'user', content: prompt }], system)) {
        output += delta
      }
      return output.trim() || buildFallbackSummary(results)
    } catch (error: any) {
      logger.error({ err: error?.message }, 'Synthesizer LLM call failed')
      return buildFallbackSummary(results)
    }
  }
}

function formatTypedBlackboardEntries(entries: BlackboardEntry[]): string {
  const typed = entries
    .map((entry) => {
      const value = entry.value as { schemaType?: string; summary?: string } | null
      if (!value?.schemaType) return null
      return {
        key: entry.key,
        schemaType: value.schemaType,
        summary: value.summary ?? '',
      }
    })
    .filter((entry): entry is { key: string; schemaType: string; summary: string } => Boolean(entry))

  if (typed.length === 0) return '暂无结构化条目。'

  return typed
    .slice(0, 30)
    .map((entry) => `- [${entry.schemaType}] ${entry.key}: ${entry.summary}`)
    .join('\n')
}

function buildFallbackSummary(results: TaskResult[]): string {
  const doneResults = results.filter((r) => r.status === 'done')
  const failedResults = results.filter((r) => r.status === 'failed')

  const agentOutputs = doneResults.map((r) => {
    const compact = r.output.trim().replace(/\n{3,}/g, '\n\n').slice(0, 800)
    return [
      `### ${r.agentName} — ${r.taskId}`,
      compact || '无输出。',
      r.artifacts.length > 0 ? `- 产物：${r.artifacts.map((a) => (a as { filePath?: string }).filePath || 'artifact').join(', ')}` : '',
    ].join('\n')
  })

  const riskSection = failedResults.length > 0
    ? failedResults.map((r) => `- **${r.agentName}** 的任务 **${r.taskId}** 执行失败，需人工检查或重试。`).join('\n')
    : '未发现明显风险。'

  return [
    '## 执行摘要',
    `本次协调共包含 ${results.length} 个子任务，其中 ${doneResults.length} 个成功完成，${failedResults.length} 个失败。`,
    '',
    '## 各 Agent 产出',
    ...agentOutputs.flatMap((s) => [s, '']),
    '## 冲突处理',
    '无代码冲突。',
    '',
    '## 风险与建议',
    riskSection,
    '',
    '## 下一步行动',
    '1. 检查失败任务的状态和日志，决定是否需要重试。',
    '2. 在群聊中 @具体 Agent 追问细节。',
    '3. 如需继续推进，可让 Orchestrator 规划下一轮任务。',
  ].join('\n')
}
