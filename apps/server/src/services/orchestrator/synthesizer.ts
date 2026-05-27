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
要求：
1. 整合为连贯叙述，消除重复，统一术语
2. 明确标注各部分的贡献者
3. 指出不一致、风险或需要人工决策的地方
4. 如果有代码冲突，说明冲突处理结果
5. 给出下一步行动建议
6. 使用 Markdown 格式，中文回复`

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
  const sections = results.map((r, index) => {
    const compact = r.output.trim().replace(/\n{3,}/g, '\n\n').slice(0, 1400)
    return [`${index + 1}. ${r.taskId} (${r.agentName}) [${r.status}]`, compact || '无输出。'].join('\n')
  })

  return [
    '**Orchestrator 汇总**',
    '',
    `已监听到 ${results.length} 个子会话完成，下面是合并后的结果：`,
    '',
    ...sections.flatMap((section) => [section, '']),
    '后续可以继续在群聊里 @具体 Agent 追问，或让 Orchestrator 继续拆下一轮任务。',
  ].join('\n')
}
